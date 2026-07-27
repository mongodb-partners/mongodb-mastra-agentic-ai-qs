import { MongoClient } from 'mongodb';
import { loadConfig } from '../src/config';
import { logger } from '../src/observability/logger';
import { RECORDING_COLLECTIONS, snapshotReplay } from '../src/data/replay-store';
import { collectProvenance } from './replay-provenance';

/**
 * Freeze the run that is ALREADY in the working collections into the immutable `replay_*` copies.
 *
 * This is `pnpm bake` without its destructive half. Bake does three things — clear prior run state,
 * investigate every pending case with the real LLM, snapshot the result — and the first is a
 * `deleteMany({})` across six collections. That makes bake the right tool for producing a recording
 * on a scratch cluster and the wrong tool for capturing one that has already happened: pointing it at
 * an operational database destroys the very run you wanted to keep, and there is no undo, because the
 * model output is not reproducible.
 *
 * So when the run worth keeping is the one a live deployment just produced — a clean sweep, every
 * case decided, the audit chain intact — this captures it and touches nothing else. Read-only with
 * respect to the working collections; the only writes are to `replay_*` and `replay_meta`.
 *
 * The recorded corpus size is captured here too (see ReplayMeta), which is why capturing on the box
 * that holds the corpus matters: the scale travels with the artifact, so the cluster that later
 * replays it does not need the corpus at all.
 *
 * Provenance flags, both optional and both recorded as 'unknown' when omitted:
 *   --commit <sha>   the app commit that produced the run. Pass it when running in the container:
 *                    the image excludes `.git`, so git cannot answer there.
 *   --tier <M30>     the source cluster's Atlas tier, which the recorded timings are only valid at.
 *
 * Pair with `pnpm export:replay` to get the artifact off the box.
 */
async function main() {
  try { process.loadEnvFile(); } catch { /* .env optional */ }
  const cfg = loadConfig();

  // Refuse to snapshot from a demo-mode box. There, the working collections are not where the
  // recording lives — reads route to `replay_*` — so a "snapshot" would copy whatever stale run state
  // happens to sit in them over the good recording. Almost certainly nothing, which is worse: it
  // would silently blank the replay rather than fail.
  if (cfg.demoMode) {
    throw new Error(
      'DEMO_MODE is on: this box replays a recording rather than producing one. Snapshotting here ' +
      'would overwrite the replay collections with unused live-run state. Run this on a live box.',
    );
  }

  const client = new MongoClient(cfg.mongoUri);
  await client.connect();
  try {
    const db = client.db(cfg.mongoDb);

    // A snapshot of nothing is the failure mode worth naming: it succeeds, reports zeros, and leaves
    // the deployment with an empty replay that only shows up as a blank console at demo time.
    const present: Record<string, number> = {};
    for (const n of RECORDING_COLLECTIONS) present[n] = await db.collection(n).countDocuments();
    if (!present.agent_events || !present.case_analysis) {
      throw new Error(
        `nothing to snapshot on ${cfg.mongoDb}: ${JSON.stringify(present)} — run an investigation first`,
      );
    }
    logger.info('snapshotting the current live run', { db: cfg.mongoDb, ...present });

    const provenance = collectProvenance({
      argv: process.argv.slice(2), env: process.env, llmModel: cfg.llmModel,
    });
    // Logged before the write, and at warn when anything is missing: 'unknown' is a supported value
    // but a silent one, and the moment to notice is while the operator is still at the prompt — after
    // the export it is committed into the artifact and only a re-bake can change it.
    const missing = Object.entries(provenance).filter(([, v]) => v === 'unknown').map(([k]) => k);
    if (missing.length) {
      logger.warn('recording provenance incomplete — pass --commit / --tier to attribute it', {
        missing, ...provenance,
      });
    } else {
      logger.info('stamping recording provenance', { ...provenance });
    }

    const counts = await snapshotReplay(db, provenance);
    logger.info('replay snapshot written (demo mode reads these; live runs never touch them)', counts);
  } finally {
    await client.close();
  }
}

main().then(() => process.exit(0)).catch(err => {
  logger.error('snapshot failed', { err: String(err?.message ?? err) });
  process.exit(1);
});
