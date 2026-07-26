import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MongoClient, BSON } from 'mongodb';
import { DEV_AUDIT_SECRET, loadConfig } from '../src/config';
import { logger } from '../src/observability/logger';
import { REPLAY_COLLECTIONS } from '../src/data/replay-store';
import { resignRecords } from '../src/governance/resign-chain';

/**
 * Export the immutable demo recording (the `replay_*` collections) to versioned JSON under
 * `data/replay/`. This is the DATA-SAFETY step: `pnpm bake` produces a recording by running the
 * real LLM once (non-reproducible — model output varies), so the only way to preserve an exact
 * recording is to commit it. `pnpm restore:replay` loads it back onto any cluster with no LLM.
 *
 * Uses Extended JSON so ObjectIds, Dates, and insertion order survive the round-trip — order and
 * `_id` matter for the audit hash chain, which `verify()` recomputes in `_id` order.
 *
 * THE AUDIT CHAIN IS NORMALIZED TO THE DEV SECRET ON THE WAY OUT. The exported chain's HMACs are
 * only meaningful next to the key that produced them, and `restore:replay` relies on the artifact
 * being dev-signed: it re-signs dev → this-deployment, and treats a chain that verifies under
 * neither as tampering. Baking is nominally a local step, so that used to hold by accident — until
 * a bake had to run ON a deployed box (the least-privilege demo user cannot write a scratch DB, so
 * the bake ran on the live Track B box under its own AUDIT_SECRET). The export then carried Track
 * B's key, Track B's own restore passed as `already_valid`, and restoring the SAME artifact to Track
 * A aborted with three `hmac_mismatch` links and no `chain_link_broken` — a correct refusal to
 * launder what looked like tampering. Normalizing here makes the artifact independent of whichever
 * box baked it, which is the property the committed recording is supposed to have.
 */
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'replay');

/**
 * Rewrite the audit chain's hashes so the committed file is signed with the dev secret regardless of
 * which box baked it. Content is never touched — only previous_hash/current_hash/hmac_key_version.
 * Aborts rather than exporting a chain that verifies under neither key, since that is real tampering
 * and an artifact carrying it would be restored onto every box.
 */
function normalizeAudit(docs: any[], secret: string): any[] {
  if (!docs.length || secret === DEV_AUDIT_SECRET) return docs;
  const out = resignRecords(docs as any, secret, DEV_AUDIT_SECRET);
  if (!out) {
    throw new Error(
      `audit chain in ${REPLAY_COLLECTIONS.audit_trail} (${docs.length} records) does not verify ` +
      "under this environment's AUDIT_SECRET — refusing to export a chain that may be tampered.",
    );
  }
  logger.info('normalized exported audit chain to the dev secret', { records: out.length });
  return out as any[];
}

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
    let docs = await db.collection(dst).find({}).sort({ _id: 1 }).toArray();
    if (dst === REPLAY_COLLECTIONS.audit_trail) docs = normalizeAudit(docs, cfg.auditSecret);
    // EJSON (relaxed=false) preserves ObjectId/Date types exactly for a clean restore.
    writeFileSync(join(OUT_DIR, `${dst}.json`), BSON.EJSON.stringify(docs, undefined, 2, { relaxed: false }));
    summary[dst] = docs.length; total += docs.length;
  }
  logger.info('exported demo recording to data/replay/', summary);
  if (!total) logger.warn('recording is EMPTY — run `pnpm bake` before exporting');

  await client.close();
}

main().then(() => process.exit(0)).catch(err => { logger.error('export-replay failed', { err: String(err) }); process.exit(1); });
