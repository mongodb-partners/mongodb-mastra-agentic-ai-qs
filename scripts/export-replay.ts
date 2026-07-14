import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MongoClient, BSON } from 'mongodb';
import { loadConfig } from '../src/config';
import { logger } from '../src/observability/logger';
import { REPLAY_COLLECTIONS } from '../src/data/replay-store';

/**
 * Export the immutable demo recording (the `replay_*` collections) to versioned JSON under
 * `data/replay/`. This is the DATA-SAFETY step: `pnpm bake` produces a recording by running the
 * real LLM once (non-reproducible — model output varies), so the only way to preserve an exact
 * recording is to commit it. `pnpm restore:replay` loads it back onto any cluster with no LLM.
 *
 * Uses Extended JSON so ObjectIds, Dates, and insertion order survive the round-trip — order and
 * `_id` matter for the audit hash chain, which `verify()` recomputes in `_id` order.
 */
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'replay');

async function main() {
  try { process.loadEnvFile(); } catch { /* .env optional */ }
  const cfg = loadConfig();
  const client = new MongoClient(cfg.mongoUri);
  await client.connect();
  const db = client.db(cfg.mongoDb);
  mkdirSync(OUT_DIR, { recursive: true });

  const summary: Record<string, number> = {};
  let total = 0;
  for (const dst of Object.values(REPLAY_COLLECTIONS)) {
    const docs = await db.collection(dst).find({}).sort({ _id: 1 }).toArray();
    // EJSON (relaxed=false) preserves ObjectId/Date types exactly for a clean restore.
    writeFileSync(join(OUT_DIR, `${dst}.json`), BSON.EJSON.stringify(docs, undefined, 2, { relaxed: false }));
    summary[dst] = docs.length; total += docs.length;
  }
  logger.info('exported demo recording to data/replay/', summary);
  if (!total) logger.warn('recording is EMPTY — run `pnpm bake` before exporting');

  await client.close();
}

main().then(() => process.exit(0)).catch(err => { logger.error('export-replay failed', { err: String(err) }); process.exit(1); });
