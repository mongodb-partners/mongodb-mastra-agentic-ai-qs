import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { MongoClient, BSON } from 'mongodb';
import { DEV_AUDIT_SECRET, loadConfig } from '../src/config';
import { logger } from '../src/observability/logger';
import { REPLAY_COLLECTIONS, REPLAY_META_COLLECTION } from '../src/data/replay-store';
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
export function normalizeAudit(docs: any[], secret: string): any[] {
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

export interface StagedFile { path: string; json: string; count: number }

/**
 * Read + normalize + serialize all four collections, returning what SHOULD be written — without
 * writing any of it.
 *
 * READ AND VALIDATE EVERYTHING BEFORE WRITING ANYTHING. The four files are one artifact: a restore
 * loads all of them, and the audit chain's hashes only mean anything next to the events they
 * describe. normalizeAudit() can throw, and `replay_audit` is LAST in REPLAY_COLLECTIONS, so the
 * write-as-you-go loop this replaces left the other three files already overwritten from the cluster
 * while replay_audit kept its committed content — a torn recording that still looks like a clean
 * checkout to anyone who reads only the error. Observed while exercising the abort path against a
 * scratch cluster: `git status` showed three modified files after a run that exited 1.
 *
 * Separated from the writing so the all-or-nothing property is testable without a database: `load`
 * is the only I/O and the caller writes only if this returns.
 */
export async function stageExport(
  load: (collection: string) => Promise<any[]>, secret: string, outDir = OUT_DIR,
): Promise<StagedFile[]> {
  const staged: StagedFile[] = [];
  // REPLAY_META_COLLECTION is exported alongside the four recording collections because the
  // recording's scale is part of the recording: demo mode reports `counts.transactions` from it, so
  // an artifact without it replays a 1M run while reporting whatever the replaying cluster holds.
  for (const dst of [...Object.values(REPLAY_COLLECTIONS), REPLAY_META_COLLECTION]) {
    let docs = await load(dst);
    if (dst === REPLAY_COLLECTIONS.audit_trail) docs = normalizeAudit(docs, secret);
    // EJSON (relaxed=false) preserves ObjectId/Date types exactly for a clean restore.
    staged.push({ path: join(outDir, `${dst}.json`), count: docs.length,
                  json: BSON.EJSON.stringify(docs, undefined, 2, { relaxed: false }) });
  }
  return staged;
}

async function main() {
  try { process.loadEnvFile(); } catch { /* .env optional */ }
  const cfg = loadConfig();
  const client = new MongoClient(cfg.mongoUri);
  await client.connect();
  const db = client.db(cfg.mongoDb);
  mkdirSync(OUT_DIR, { recursive: true });

  const staged = await stageExport(
    dst => db.collection(dst).find({}).sort({ _id: 1 }).toArray(), cfg.auditSecret);
  for (const f of staged) writeFileSync(f.path, f.json);

  const summary = Object.fromEntries(staged.map(f => [basename(f.path, '.json'), f.count]));
  logger.info('exported demo recording to data/replay/', summary);
  if (!staged.some(f => f.count)) logger.warn('recording is EMPTY — run `pnpm bake` before exporting');

  await client.close();
}

// Only run when executed as a script. Without this guard, importing anything from this module — as
// export-replay.test.ts does — would connect to whatever cluster the ambient env points at and
// overwrite data/replay/ as a side effect of collecting the test file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit(0)).catch(err => { logger.error('export-replay failed', { err: String(err) }); process.exit(1); });
}
