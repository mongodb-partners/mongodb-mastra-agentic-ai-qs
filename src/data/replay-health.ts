import type { Db } from 'mongodb';
import { TRANSACTIONS_COLLECTION } from '../mastra/schemas/transactions';
import { REPLAY_COLLECTIONS, readReplayMeta } from './replay-store';

/**
 * Health checks for the baked demo recording, run after `pnpm restore:replay`.
 *
 * The recording is a frozen artifact but it is not self-contained: it cites transaction ids that
 * must exist on the cluster, and it carries timestamps the client uses as pacing. Both go stale
 * silently, and every one of these has actually bitten a deployment:
 *
 *   DANGLING PRECEDENTS — the recording was baked against SEED_SCALE_COUNT=1200, but boxes deploy
 *     at 60. Twelve of the thirteen `txn-syn-*` precedent ids in the recording resolved to nothing,
 *     so the replay showed precedent chips that opened onto an empty case. Nothing errored.
 *
 *   STALE PACING — public/app.js paces the replay off the recorded `ts` deltas, deliberately, so
 *     the demo shows real pipeline timing. When the pipeline gets faster the recording does not,
 *     and the replay runs visibly slower than the live app on the same stages (measured 148 s of
 *     recording against a 48 s live run). The same timestamps feed `latency_p50_ms`, so the demo
 *     also *reports* the stale number.
 *
 * These are warnings, not failures: an operator restoring a recording onto a small cluster should
 * be told, not blocked. `strict` turns them into an error for CI.
 */

/** Gaps at or under this are sub-frame — the client floors them, so they aren't really pacing. */
const SUB_FRAME_MS = 140;
/** The client clamps a single gap to this; more than a couple means the recording is much slower. */
const CLAMP_MS = 6000;
/** Warn when the recording's own span exceeds the live pipeline's by more than this factor. */
const MAX_SPAN_RATIO = 1.75;

export interface ReplayHealthReport {
  ok: boolean;
  warnings: string[];
  /** Precedent/memory ids cited by the recording that do not exist in `transactions`. */
  danglingIds: string[];
  corpusSize: number;
  /**
   * Corpus size the recording was produced against, when it carries one. Non-null means the
   * dangling-id check above is informational rather than a warning — see the comment at its call
   * site — and is what demo mode publishes as `counts.transactions`.
   */
  recordedCorpusSize: number | null;
  /** Wall-clock span of the recording in ms, i.e. what the replay will take to play. */
  recordingSpanMs: number;
  /** How many recorded gaps the client's MAX clamp would bite. */
  clampedGaps: number;
  /** How many recorded gaps sit at or under the client's sub-frame floor. */
  subFrameGaps: number;
  /** How many gaps there are in total — the denominator for both threshold checks. */
  totalGaps: number;
}

function tsMs(ts: unknown): number {
  if (ts instanceof Date) return ts.getTime();
  const n = Date.parse(String(ts));
  return Number.isFinite(n) ? n : NaN;
}

/** Every transaction id the recording points at, from precedents and recalled memory. */
function citedIds(analyses: any[]): Set<string> {
  const ids = new Set<string>();
  for (const a of analyses) {
    for (const p of a?.precedents ?? []) if (p?.transaction_id) ids.add(String(p.transaction_id));
    for (const m of a?.memory ?? []) if (m?.transaction_id) ids.add(String(m.transaction_id));
  }
  return ids;
}

/**
 * Inspect the restored recording against the cluster it now sits on.
 *
 * `liveSpanMs`, when known (e.g. from a prior live run), enables the pacing-staleness check. Without
 * it the span is still reported, just not judged.
 */
export async function checkReplayHealth(
  db: Db, opts: { liveSpanMs?: number } = {},
): Promise<ReplayHealthReport> {
  const warnings: string[] = [];

  const analyses = await db.collection(REPLAY_COLLECTIONS.case_analysis).find({}).toArray();
  const events = await db.collection(REPLAY_COLLECTIONS.agent_events).find({}).sort({ _id: 1 }).toArray();
  const corpusSize = await db.collection(TRANSACTIONS_COLLECTION).countDocuments({});

  // ── Dangling ids. One query, not one per id: the corpus can be thousands of docs.
  const cited = [...citedIds(analyses)];
  const present = new Set(
    (await db.collection(TRANSACTIONS_COLLECTION)
      .find({ transaction_id: { $in: cited } }, { projection: { _id: 0, transaction_id: 1 } })
      .toArray()).map(d => String(d.transaction_id)),
  );
  const danglingIds = cited.filter(id => !present.has(id));
  // Only a warning when the recording was baked against THIS cluster. A recording carrying its own
  // `corpus_size` (see ReplayMeta) is replayed on a box that deliberately does not hold the corpus:
  // precedent content is stored inline in `replay_analysis` and renders from the snapshot, and no
  // precedent is clickable, so nothing resolves against `transactions` during a replay.
  //
  // Warning anyway would be worse than noise. Synthetic ids are POSITIONAL (`txn-syn-00016`), so the
  // same id names a different transaction in two corpora built by different revisions of the
  // generator — measured: `structuring`/escalated in the 12k corpus, `clean_approve`/approved in the
  // 1M one. An operator told to "seed the corpus the recording expects" would be seeding look-alikes
  // that silence this check while making it mean nothing. Absent is honest; look-alike is not.
  const recorded = await readReplayMeta(db);
  if (danglingIds.length && !recorded) {
    warnings.push(
      `${danglingIds.length}/${cited.length} precedent id(s) cited by the recording are NOT in ` +
      `\`${TRANSACTIONS_COLLECTION}\` (corpus=${corpusSize}): ${danglingIds.slice(0, 6).join(', ')}` +
      `${danglingIds.length > 6 ? ', …' : ''}. The replay will show precedents that resolve to ` +
      'nothing. Re-bake the recording against this corpus, or seed the corpus the recording expects.',
    );
  }

  // ── Pacing. Recording span is what the viewer will actually sit through.
  const stamps = events.map(e => tsMs(e.ts)).filter(Number.isFinite);
  const recordingSpanMs = stamps.length > 1 ? stamps[stamps.length - 1] - stamps[0] : 0;
  let clampedGaps = 0;
  let subFrame = 0;
  for (let i = 1; i < stamps.length; i++) {
    const gap = stamps[i] - stamps[i - 1];
    if (gap > CLAMP_MS) clampedGaps++;
    if (gap <= SUB_FRAME_MS) subFrame++;
  }
  if (opts.liveSpanMs && recordingSpanMs > opts.liveSpanMs * MAX_SPAN_RATIO) {
    warnings.push(
      `recording spans ${(recordingSpanMs / 1000).toFixed(1)}s but the live pipeline runs the same ` +
      `cases in ${(opts.liveSpanMs / 1000).toFixed(1)}s (${(recordingSpanMs / opts.liveSpanMs).toFixed(1)}x). ` +
      'The replay paces off these timestamps, so it will look slower than the live app and ' +
      'latency_p50_ms will report the stale figure. Re-time the recording from a current live run.',
    );
  }
  if (stamps.length > 1 && clampedGaps > stamps.length / 4) {
    warnings.push(
      `${clampedGaps}/${stamps.length - 1} recorded gaps exceed the client's ${CLAMP_MS}ms clamp — ` +
      'the replay will be dominated by clamped waits rather than the recorded shape.',
    );
  }
  if (stamps.length > 1 && subFrame > (stamps.length - 1) * 0.75) {
    warnings.push(
      `${subFrame}/${stamps.length - 1} recorded gaps are <=${SUB_FRAME_MS}ms — the client's pacing ` +
      'floors are setting the tempo, not the recording. Re-tune REPLAY_PACE in public/app.js.',
    );
  }

  return {
    ok: warnings.length === 0, warnings, danglingIds, corpusSize,
    recordedCorpusSize: recorded?.corpus_size ?? null,
    recordingSpanMs, clampedGaps,
    subFrameGaps: subFrame, totalGaps: Math.max(0, stamps.length - 1),
  };
}
