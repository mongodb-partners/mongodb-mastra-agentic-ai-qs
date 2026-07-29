import { MongoClient } from 'mongodb';
import { loadConfig } from '../src/config';
import { logger } from '../src/observability/logger';
import {
  assertRankFusionSupported, provisionTransactionVectorIndex, provisionTransactionSearchIndex,
  provisionGraphIndexes,
} from '../src/data/provision-transactions';
import { seedTransactions, seedSyntheticCorpus, countDecidedPrecedents } from '../src/data/seed-transactions';
import { runSearchSelfCheck } from '../src/data/search-self-check';
import { checkReplayHealth } from '../src/data/replay-health';
import { TRANSACTIONS_COLLECTION } from '../src/mastra/schemas/transactions';
import { provisionPolicyIndexes, seedPolicies } from '../src/governance/provision-policies';
import { getQueryEmbedder } from '../src/mastra/embed';
import { createVectorStore, registerByoIndexes } from '../src/retrieval/vector-store';
import { WorkflowsStorageMongoDB } from '@mastra/mongodb';
import { WORKFLOW_SNAPSHOT_COLLECTION } from '../src/workflow/review-workflow';

async function main() {
  try { process.loadEnvFile(); } catch { /* .env optional */ }
  const cfg = loadConfig();
  const client = new MongoClient(cfg.mongoUri);
  try {
    await client.connect();
    const db = client.db(cfg.mongoDb);

    await assertRankFusionSupported(db);
    await provisionTransactionVectorIndex(db);
    // RECREATE_SEARCH_INDEX=1 drops and rebuilds the BM25 index. Needed whenever the mapping in
    // provisionTransactionSearchIndex changes, because Atlas cannot update a mapping in place and
    // the function is otherwise a no-op on a cluster that already has the index. Off by default:
    // a rebuild leaves the collection with no lexical index while it builds.
    await provisionTransactionSearchIndex(db, { recreate: process.env.RECREATE_SEARCH_INDEX === '1' });

    // Standard indexes: upserts key on transaction_id; the queue sorts by created_at; the stats
    // readout and precedent filter count by status. Matters once the corpus is 1,000+ docs.
    const txCol = db.collection(TRANSACTIONS_COLLECTION);
    await txCol.createIndex({ transaction_id: 1 }, { unique: true }).catch(() => {});
    await txCol.createIndex({ created_at: -1 }).catch(() => {});
    await txCol.createIndex({ status: 1 }).catch(() => {});
    await db.collection('agent_events').createIndex({ transaction_id: 1, ts: 1 }).catch(() => {});

    // Graph traversal indexes. Deliberately NOT .catch()-swallowed like the four above: a missing
    // graph index doesn't fail the ring trace, it silently degrades it to a collection scan per
    // depth level. See provisionGraphIndexes.
    await provisionGraphIndexes(db);

    const embedder = getQueryEmbedder(cfg);
    // `embedDocuments`, not a map of `embedQuery`: these curated transactions are stored documents,
    // and Voyage's asymmetric models embed differently for `inputType: 'query'` vs `'document'`.
    // Embedding a stored doc as a query put the 15 curated cases in a slightly different space from
    // the synthetic corpus below (which always used embedDocuments), so their retrieval scores were
    // not directly comparable. It also batches, instead of one HTTP round-trip per case.
    const embed = (texts: string[]) => embedder.embedDocuments(texts);
    const written = await seedTransactions(db.collection(TRANSACTIONS_COLLECTION) as any, embed);
    logger.info('seeded transactions', { written });

    // Scale corpus: batch-embedded synthetic decided precedents (SEED_SCALE_COUNT, default 1200).
    if (cfg.seedScaleCount > 0) {
      const scale = await seedSyntheticCorpus(
        db.collection(TRANSACTIONS_COLLECTION) as any,
        texts => embedder.embedDocuments(texts),
        cfg.seedScaleCount,
      );
      logger.info('seeded synthetic scale corpus', scale);
    }
    logger.info('decided precedents', {
      count: await countDecidedPrecedents(db.collection(TRANSACTIONS_COLLECTION) as any),
    });

    await runSearchSelfCheck(db, embed);

    // Policy governance layer: indexes + seed policy set on the same cluster.
    await provisionPolicyIndexes(db);
    const policies = await seedPolicies(db, embed);
    logger.info('seeded policies', { policies });

    // Per-session state: index by session, TTL 24h so demo sessions self-clean.
    await db.collection('session_resolutions').createIndex({ sessionId: 1 }).catch(() => {});
    await db.collection('session_resolutions').createIndex({ decided_at: 1 }, { expireAfterSeconds: 86400 }).catch(() => {});
    logger.info('provisioned session_resolutions (indexed + 24h TTL)');

    // Durable review gate: `mastra_workflow_snapshot` is created and indexed by the workflows engine
    // itself, so this run deliberately neither creates it nor adds indexes to it — and equally
    // deliberately gives it NO TTL, unlike session_resolutions above: a case can sit with a human for
    // days, and expiring the snapshot would silently delete the pause.
    //
    // Measured on the box: the engine creates it at APP BOOT, empty, not on the first suspended run —
    // so a freshly provisioned cluster shows 11 collections the moment the server starts, and an empty
    // `mastra_workflow_snapshot` means "nothing is paused", not "the gate has never been wired up".
    //
    // What IS checked is the name, against the library's own declaration. `WORKFLOW_SNAPSHOT_COLLECTION`
    // is what the live-mode reset clears (routes.ts); if a library upgrade renamed the collection, the
    // reset would go on succeeding while clearing nothing, leaving orphaned runs. Cheap, no I/O, and
    // it fails on the provision run rather than in front of an audience.
    const managed = WorkflowsStorageMongoDB.MANAGED_COLLECTIONS as readonly string[];
    if (!managed.includes(WORKFLOW_SNAPSHOT_COLLECTION)) {
      throw new Error(
        `@mastra/mongodb manages [${managed.join(', ')}], not '${WORKFLOW_SNAPSHOT_COLLECTION}' — ` +
        'update WORKFLOW_SNAPSHOT_COLLECTION and the live-mode reset list in src/server/routes.ts.',
      );
    }
    logger.info('durable review gate collection is engine-managed', {
      collection: WORKFLOW_SNAPSHOT_COLLECTION, created_on: 'app boot', ttl: 'none',
    });

    // Register both collections with @mastra/mongodb as READ-ONLY bring-your-own indexes. LAST, on
    // purpose: every index above must already exist so this finds them and no-ops rather than
    // creating its own — the app's definitions carry `quantization: 'binary'` and the filter paths,
    // neither of which `createIndex` can express. Its own connection, closed straight away; the
    // long-lived store belongs to the server process, not to a provision run.
    const vector = await createVectorStore(cfg, 'marshal-provision');
    try {
      logger.info('registered BYO vector indexes', { indexes: await registerByoIndexes(vector) });
    } finally {
      await vector.disconnect();
    }

    // A recording already on this cluster was baked against whatever corpus existed then. Re-seeding
    // at a different SEED_SCALE_COUNT silently strands the precedent ids it cites — the replay shows
    // chips that open onto nothing. Warn here rather than at demo time; the recording is what needs
    // fixing (`pnpm bake`, or the overlay's rebake-replay-precedents), not this seed run.
    const replayHealth = await checkReplayHealth(db);
    for (const w of replayHealth.warnings) logger.warn(`replay staleness after re-seed: ${w}`);

    logger.info('provision-and-seed complete');
  } finally {
    await client.close();
  }
}

main().then(() => process.exit(0)).catch(err => {
  logger.error('provision-and-seed failed', { err: String(err) });
  process.exit(1);
});
