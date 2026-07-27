/**
 * Bring the synthetic scale corpus to SEED_SCALE_COUNT and touch NOTHING else.
 *
 * `provision-and-seed.ts` is the full bringup: it asserts $rankFusion, (re)provisions the vector and
 * search indexes, re-upserts the 15 curated seeds, re-seeds the policies, and runs the search
 * self-check. All of that is correct on a fresh cluster and unnecessary — and on a LIVE box,
 * unwelcome — when the only difference is the corpus size. Re-upserting the curated seeds rewrites
 * the very documents the demo narrates, and re-seeding policies fires the change stream's
 * "POLICY UPDATED LIVE" banner on every connected console.
 *
 * So this script calls exactly one thing: seedSyntheticCorpus, with the same generator and the same
 * document embedder the provision path uses, so the vectors it writes are indistinguishable from
 * the ones already there. Which makes it the tool for syncing one box's corpus up to another's.
 *
 * Safe to re-run and safe to interrupt. seedSyntheticCorpus reads which `txn-syn-` ids already
 * exist and inserts only the missing ones in 200-doc chunks, so a run that dies halfway leaves a
 * consistent prefix and the next run resumes from it. The corpus is deterministic —
 * mulberry32(seed=42), ids `txn-syn-00001…` — so record i depends only on the RNG stream up to i:
 * raising the count re-derives the identical earlier documents (expect `removed: 0`). LOWERING it
 * deletes the surplus, which is why the count is echoed before the write.
 *
 * Never touches AUDIT_SECRET or the audit chain — only `restore:replay` re-signs — so this cannot
 * produce the "AUDIT CHAIN BROKEN" banner.
 *
 * Usage (env wins over .env — process.loadEnvFile does not overwrite exported vars):
 *   SEED_SCALE_COUNT=12000 MONGODB_URI=… MONGODB_DB=marshal tsx scripts/sync-scale-corpus.ts
 */
import { MongoClient } from 'mongodb';
import { loadConfig } from '../src/config';
import { logger } from '../src/observability/logger';
import { seedSyntheticCorpus, countDecidedPrecedents } from '../src/data/seed-transactions';
import { TRANSACTIONS_COLLECTION } from '../src/mastra/schemas/transactions';
import { getQueryEmbedder } from '../src/mastra/embed';
import { SYNTHETIC_ID_PREFIX } from '../src/data/synthetic-corpus';

async function main() {
  try { process.loadEnvFile(); } catch { /* .env optional */ }
  const cfg = loadConfig();
  if (cfg.seedScaleCount <= 0) {
    logger.error('SEED_SCALE_COUNT is 0 — refusing to run', { seedScaleCount: cfg.seedScaleCount });
    process.exit(1);
  }

  const client = new MongoClient(cfg.mongoUri);
  try {
    await client.connect();
    const col = client.db(cfg.mongoDb).collection(TRANSACTIONS_COLLECTION);

    // Echo the before/after intent first: a LOWER target silently deletes documents, and on a live
    // box that should be visible in the log before it happens rather than inferred afterwards.
    const before = await col.countDocuments({ transaction_id: { $regex: `^${SYNTHETIC_ID_PREFIX}` } });
    logger.info('scale corpus sync starting', {
      db: cfg.mongoDb, synthetic: before, target: cfg.seedScaleCount,
      action: cfg.seedScaleCount > before ? `insert ${cfg.seedScaleCount - before}`
        : cfg.seedScaleCount < before ? `DELETE ${before - cfg.seedScaleCount}` : 'nothing to do',
    });

    const embedder = getQueryEmbedder(cfg);
    // seedSyntheticCorpus refuses a large shrink by default, because the same call from the
    // provision path against a big corpus with a small SEED_SCALE_COUNT would silently destroy it.
    // This script IS the deliberate-resize tool and logs the delete count above, but a large
    // shrink still needs saying out loud: ALLOW_SHRINK=1.
    const scale = await seedSyntheticCorpus(
      col as any, texts => embedder.embedDocuments(texts), cfg.seedScaleCount,
      { allowShrink: process.env.ALLOW_SHRINK === '1' },
    );
    logger.info('scale corpus synced', scale);
    logger.info('totals', {
      transactions: await col.countDocuments(),
      decidedPrecedents: await countDecidedPrecedents(col as any),
    });
  } finally {
    await client.close();
  }
}

main().catch(err => { logger.error('scale corpus sync failed', { err: String(err) }); process.exit(1); });
