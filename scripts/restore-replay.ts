import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MongoClient, BSON } from 'mongodb';
import { DEV_AUDIT_SECRET, loadConfig } from '../src/config';
import { logger } from '../src/observability/logger';
import { REPLAY_COLLECTIONS, REPLAY_META_COLLECTION, readReplayMeta } from '../src/data/replay-store';
import { resignAuditChain } from '../src/governance/resign-chain';
import { checkReplayHealth } from '../src/data/replay-health';

/**
 * Restore the demo recording from the versioned JSON in `data/replay/` into the immutable
 * `replay_*` collections — no LLM required. Use this to stand up demo mode on a fresh cluster, or
 * to recover the exact committed recording. Idempotent: each collection is dropped and reloaded.
 *
 * Note: this only writes the recording. Run `pnpm provision` first so the transactions/policies
 * the recording references exist on the cluster.
 *
 * Two post-restore fences run automatically, because the raw restore alone has repeatedly produced
 * a broken-looking demo on a fresh box:
 *   1. The restored audit chain is re-signed under this deployment's AUDIT_SECRET. The committed
 *      chain is signed with the dev fallback (baking is a local step), so a box with a real secret
 *      would show "AUDIT CHAIN BROKEN" on an untampered ledger. See src/governance/resign-chain.ts.
 *   2. `checkReplayHealth` warns when the recording has gone stale against this cluster — precedent
 *      ids that don't exist here, or timings the pipeline has long since beaten.
 * `--strict` turns the health warnings into a non-zero exit for CI.
 */
const IN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'replay');
const STRICT = process.argv.includes('--strict');

async function main() {
  try { process.loadEnvFile(); } catch { /* .env optional */ }
  const cfg = loadConfig();
  const client = new MongoClient(cfg.mongoUri);
  await client.connect();
  const db = client.db(cfg.mongoDb);

  const summary: Record<string, number> = {};
  // Includes REPLAY_META_COLLECTION: the recorded corpus size is what demo mode publishes as
  // `counts.transactions`, so a restore that skipped it would leave the replay reporting this
  // cluster's size for a run recorded elsewhere. Absent in artifacts exported before it existed —
  // the `existsSync` skip below already handles that, and the server falls back to the live count.
  for (const dst of [...Object.values(REPLAY_COLLECTIONS), REPLAY_META_COLLECTION]) {
    const file = join(IN_DIR, `${dst}.json`);
    if (!existsSync(file)) { logger.warn('missing export file — skipping', { file }); continue; }
    const docs = BSON.EJSON.parse(readFileSync(file, 'utf8')) as any[];
    await db.collection(dst).deleteMany({});
    if (docs.length) await db.collection(dst).insertMany(docs, { ordered: true });
    summary[dst] = docs.length;
  }
  logger.info('restored demo recording from data/replay/ (no LLM used)', summary);

  // ── Fence 1: align the restored chain with this box's key, so /api/audit/verify reads clean.
  if (cfg.auditSecret === DEV_AUDIT_SECRET) {
    logger.info('audit chain left as-is (this deployment uses the dev audit secret)');
  } else {
    const res = await resignAuditChain(
      db, REPLAY_COLLECTIONS.audit_trail, DEV_AUDIT_SECRET, cfg.auditSecret,
    );
    if (res.status === 'tampered') {
      // The chain verifies under NEITHER key. Re-signing would launder real tampering into a
      // valid-looking ledger, so stop and make a human look at it.
      throw new Error(
        `restored audit chain (${res.records} records) does not verify under this deployment's ` +
        'AUDIT_SECRET or the dev secret it was baked with — the exported ledger may be corrupt. ' +
        `Refusing to re-sign. Broken links: ${JSON.stringify(res.brokenLinks)}`,
      );
    }
    logger.info('audit chain aligned with this deployment\'s AUDIT_SECRET', {
      status: res.status, records: res.records,
    });
  }

  // ── Fence 2: report staleness. Warn by default; --strict fails the run.
  const health = await checkReplayHealth(db);
  for (const w of health.warnings) logger.warn(`replay staleness: ${w}`);
  if (health.ok) {
    logger.info('replay health OK', {
      corpus: health.corpusSize, recording_span_s: +(health.recordingSpanMs / 1000).toFixed(1),
    });
  }
  // Log the provenance whether or not the health check was clean: on a replay-only box the cited
  // ids are EXPECTED to be absent locally, so the count above is not the number a reader wants —
  // the recorded corpus is. Reported rather than warned about, per the call-site comment in
  // src/data/replay-health.ts.
  if (health.recordedCorpusSize !== null) {
    logger.info('recording carries its own corpus size — demo mode reports the recorded run', {
      recorded_corpus: health.recordedCorpusSize,
      local_corpus: health.corpusSize,
      cited_ids_absent_locally: health.danglingIds.length,
    });
  }

  await client.close();
  if (!health.ok && STRICT) {
    throw new Error(`replay health check failed with ${health.warnings.length} warning(s) (--strict)`);
  }
}

main().then(() => process.exit(0)).catch(err => { logger.error('restore-replay failed', { err: String(err) }); process.exit(1); });
