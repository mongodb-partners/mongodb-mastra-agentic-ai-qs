import { MongoClient } from 'mongodb';
import { loadConfig } from '../src/config';
import { logger } from '../src/observability/logger';
import { checkReplayHealth } from '../src/data/replay-health';

/**
 * Report whether the baked demo recording is still honest about the cluster it is deployed on.
 *
 * `pnpm restore:replay` runs the same check inline, but that only helps at restore time. Run this
 * whenever the corpus size, embedding model, or pipeline speed changes — those are the three things
 * that make a frozen recording start lying, and none of them touch the recording itself:
 *   - precedent ids the recording cites that no longer exist in `transactions`
 *   - a recording whose timings the live pipeline has beaten (the replay paces off them, and the
 *     same timestamps feed latency_p50_ms)
 *   - pacing gaps that the client's REPLAY_PACE floors/clamps have taken over
 *
 * `--live-span-ms N` supplies a current live-run wall clock so the timing check can judge rather
 * than just report. Get it from a live box: the span of one run_id in `agent_events`.
 *
 * Read-only. Exits non-zero if anything is stale, so it works as a CI or pre-demo gate.
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  try { process.loadEnvFile(); } catch { /* .env optional */ }
  const cfg = loadConfig();
  const liveSpanRaw = arg('live-span-ms');
  const liveSpanMs = liveSpanRaw ? Number(liveSpanRaw) : undefined;
  if (liveSpanRaw && !Number.isFinite(liveSpanMs)) throw new Error(`--live-span-ms must be a number, got "${liveSpanRaw}"`);

  const client = new MongoClient(cfg.mongoUri);
  await client.connect();
  try {
    const health = await checkReplayHealth(client.db(cfg.mongoDb), { liveSpanMs });
    logger.info('replay health', {
      ok: health.ok, corpus: health.corpusSize,
      recording_span_s: +(health.recordingSpanMs / 1000).toFixed(1),
      dangling_precedent_ids: health.danglingIds.length,
      sub_frame_gaps: `${health.subFrameGaps}/${health.totalGaps}`,
      clamped_gaps: `${health.clampedGaps}/${health.totalGaps}`,
    });
    for (const w of health.warnings) logger.warn(w);
    if (!health.ok) throw new Error(`${health.warnings.length} staleness warning(s)`);
    logger.info('recording is consistent with this cluster');
  } finally {
    await client.close();
  }
}

main().then(() => process.exit(0)).catch(err => {
  logger.error('check-replay failed', { err: String(err?.message ?? err) });
  process.exit(1);
});
