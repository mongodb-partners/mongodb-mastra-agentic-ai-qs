import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MongoClient, BSON } from 'mongodb';
import { loadConfig } from '../src/config';
import { logger } from '../src/observability/logger';
import { REPLAY_COLLECTIONS } from '../src/data/replay-store';

/**
 * Restore the demo recording from the versioned JSON in `data/replay/` into the immutable
 * `replay_*` collections — no LLM required. Use this to stand up demo mode on a fresh cluster, or
 * to recover the exact committed recording. Idempotent: each collection is dropped and reloaded.
 *
 * Note: this only writes the recording. Run `pnpm provision` first so the transactions/policies
 * the recording references exist on the cluster.
 */
const IN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'replay');

async function main() {
  try { process.loadEnvFile(); } catch { /* .env optional */ }
  const cfg = loadConfig();
  const client = new MongoClient(cfg.mongoUri);
  await client.connect();
  const db = client.db(cfg.mongoDb);

  const summary: Record<string, number> = {};
  for (const dst of Object.values(REPLAY_COLLECTIONS)) {
    const file = join(IN_DIR, `${dst}.json`);
    if (!existsSync(file)) { logger.warn('missing export file — skipping', { file }); continue; }
    const docs = BSON.EJSON.parse(readFileSync(file, 'utf8')) as any[];
    await db.collection(dst).deleteMany({});
    if (docs.length) await db.collection(dst).insertMany(docs, { ordered: true });
    summary[dst] = docs.length;
  }
  logger.info('restored demo recording from data/replay/ (no LLM used)', summary);

  await client.close();
}

main().then(() => process.exit(0)).catch(err => { logger.error('restore-replay failed', { err: String(err) }); process.exit(1); });
