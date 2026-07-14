import { MongoClient } from 'mongodb';
import { loadConfig } from '../src/config';
import { logger } from '../src/observability/logger';
import {
  assertRankFusionSupported, provisionTransactionVectorIndex, provisionTransactionSearchIndex,
} from '../src/data/provision-transactions';
import { seedTransactions, seedSyntheticCorpus, countDecidedPrecedents } from '../src/data/seed-transactions';
import { runSearchSelfCheck } from '../src/data/search-self-check';
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
    await provisionTransactionSearchIndex(db);

    // Standard indexes: upserts key on transaction_id; the queue sorts by created_at; the stats
    // readout and precedent filter count by status. Matters once the corpus is 1,000+ docs.
    const txCol = db.collection(TRANSACTIONS_COLLECTION);
    await txCol.createIndex({ transaction_id: 1 }, { unique: true }).catch(() => {});
    await txCol.createIndex({ created_at: -1 }).catch(() => {});
    await txCol.createIndex({ status: 1 }).catch(() => {});
    await db.collection('agent_events').createIndex({ transaction_id: 1, ts: 1 }).catch(() => {});

    const embedder = getQueryEmbedder(cfg);
    const embed = (texts: string[]) => Promise.all(texts.map(t => embedder.embedQuery(t)));
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

    logger.info('provision-and-seed complete');
  } finally {
    await client.close();
  }
}

main().then(() => process.exit(0)).catch(err => {
  logger.error('provision-and-seed failed', { err: String(err) });
  process.exit(1);
});
