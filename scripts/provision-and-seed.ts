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
