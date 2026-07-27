import type { Db } from 'mongodb';
import { scoreEval, type Disposition, type EvalCase } from '../eval/metrics';
import { EXPECTED_DISPOSITION } from '../ingestion/transaction-fixtures';
import type { Lane } from '../mastra/schemas/transactions';
import { DECIDED_STATUSES } from '../mastra/schemas/transactions';

/** Row shape pulled from case_analysis for scoring — lane + the decided disposition. */
export interface AnalysisRow { transaction_id: string; lane?: string; disposition?: string }

export interface Scorecard { n: number; accuracy: number; fraudRecall: number; f1Macro: number }

export interface StatsSnapshot {
  counts: {
    transactions: number; precedents: number; pending: number;
    policies: number; audit_events: number; agent_events: number; investigated: number;
  };
  /** Decision-quality scorecard over every investigated case (expected vs actual disposition). */
  scorecard: Scorecard | null;
  /** Median wall-clock per investigated case, from the recorded agent_events span. */
  latency_p50_ms: number | null;
  /**
   * Per-stage latency percentiles, each carrying its own `n`. These are the numbers worth
   * publishing: `retrieve` and `graph` are the Atlas-owned stages. There is deliberately NO
   * case-level p99 — a case is dominated by LLM time (reason + tool ≈ 75% measured), so its
   * tail would be Bedrock variance wearing a MongoDB label.
   */
  stages: Record<string, StagePercentiles> | null;
  /** Share of summed stage time per stage — the disclosure that keeps the above honest. */
  stage_share: Record<string, number> | null;
  generated_at: string;
}

const DISPOSITIONS: Disposition[] = ['approve', 'reject', 'escalate'];

/** Score investigated cases against their lane's expected disposition. Pure — unit-testable. */
export function buildScorecard(rows: AnalysisRow[]): Scorecard | null {
  const cases: EvalCase[] = [];
  for (const r of rows) {
    const expected = EXPECTED_DISPOSITION[r.lane as Lane];
    if (!expected || !DISPOSITIONS.includes(r.disposition as Disposition)) continue;
    cases.push({ transaction_id: r.transaction_id, lane: r.lane!, expected, actual: r.disposition as Disposition });
  }
  if (!cases.length) return null;
  const report = scoreEval(cases);
  const present = report.perClass.filter(c => c.tp + c.fn > 0); // classes with support
  const f1Macro = present.length ? present.reduce((s, c) => s + c.f1, 0) / present.length : 0;
  return {
    n: report.n,
    accuracy: report.accuracy,
    fraudRecall: report.fraudRecall,
    f1Macro: Number(f1Macro.toFixed(4)),
  };
}

/** Median of per-case durations (ms). Pure — unit-testable. */
export function medianCaseSpanMs(spans: number[]): number | null {
  if (!spans.length) return null;
  const s = [...spans].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** One recorded step event, reduced to the fields a latency span needs. */
export interface SpanEvent {
  transaction_id: string;
  step?: string;
  ts: Date | string | number;
  /** Set by the run engine; absent on events recorded before run ids existed. */
  run_id?: string;
}

/** The step that always opens an investigation — hence a run boundary for a given case. */
const OPENING_STEP = 'triage';

function msOf(ts: SpanEvent['ts']): number {
  return ts instanceof Date ? ts.getTime() : new Date(ts).getTime();
}

/**
 * Per-case wall-clock durations, split on RUN BOUNDARIES.
 *
 * WHY THIS IS NOT `max(ts) - min(ts)` PER transaction_id: `agent_events` accumulates across runs
 * (only a reset clears it), so a case investigated twice used to yield one span covering the IDLE
 * GAP BETWEEN THE RUNS. Observed on the live box: a case re-run 9 minutes later reported a 573 s
 * span, and the median of six cases came out at 290 867 ms — while every case actually completed in
 * 6–9 s. The reported p50 was ~40× the truth and grew the longer the box stayed up.
 *
 * A run is delimited two ways, because we must stay correct for events recorded before `run_id`
 * existed (a baked replay is immutable, so it can never be back-filled): a change in `run_id`, or
 * the `triage` step that always opens a case. Events must be supplied in ascending `ts` order.
 */
export function caseSpansMs(events: SpanEvent[]): number[] {
  const byCase = new Map<string, SpanEvent[]>();
  for (const e of events) {
    if (!e?.transaction_id) continue;
    const t = msOf(e.ts);
    if (!Number.isFinite(t)) continue;
    const list = byCase.get(e.transaction_id);
    if (list) list.push(e); else byCase.set(e.transaction_id, [e]);
  }

  const spans: number[] = [];
  for (const list of byCase.values()) {
    let first: number | null = null;
    let last = 0;
    let runId: string | undefined;
    const close = () => { if (first !== null && last > first) spans.push(last - first); };

    for (const e of list) {
      const t = msOf(e.ts);
      const boundary = first === null || e.step === OPENING_STEP || e.run_id !== runId;
      if (boundary) { close(); first = t; runId = e.run_id; }
      last = t;
    }
    close();
  }
  return spans;
}

/** Minimum sample size before a tail percentile is published at all. */
export const MIN_TAIL_N = 100;

export interface StagePercentiles { n: number; p50: number; p95: number | null; p99: number | null }

/** Linear-interpolated percentile over an ASCENDING sample. Pure — the caller sorts. */
export function percentile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * p50 always; p95/p99 only once the sample can actually support them.
 *
 * At n=10 a "p99" IS the maximum — one unlucky sample reported as a tail statistic. Returning
 * null is the honest answer, and `n` travels with every number so a reader can check the claim
 * instead of trusting it. (Measured on both tracks at n=6, p90 = p95 = p99 = max exactly.)
 */
export function buildStagePercentiles(durations: number[]): StagePercentiles | null {
  if (!durations.length) return null;
  const s = [...durations].sort((a, b) => a - b);
  const tail = s.length >= MIN_TAIL_N;
  return {
    n: s.length,
    p50: Number(percentile(s, 0.5).toFixed(1)),
    p95: tail ? Number(percentile(s, 0.95).toFixed(1)) : null,
    p99: tail ? Number(percentile(s, 0.99).toFixed(1)) : null,
  };
}

/**
 * Per-step durations in ms, grouped by step name.
 *
 * A step's duration is the gap to the next event of the SAME run, so this splits on run
 * boundaries for exactly the reason `caseSpansMs` does: `agent_events` accumulates across runs,
 * and a naive gap silently reports the idle time between two runs as a step duration. The last
 * event of a run has no successor and therefore contributes no duration — better than
 * fabricating one. Events must arrive in ascending `ts` order.
 */
export function stageDurationsMs(events: SpanEvent[]): Record<string, number[]> {
  const byCase = new Map<string, SpanEvent[]>();
  for (const e of events) {
    if (!e?.transaction_id || !Number.isFinite(msOf(e.ts))) continue;
    const list = byCase.get(e.transaction_id);
    if (list) list.push(e); else byCase.set(e.transaction_id, [e]);
  }
  const out: Record<string, number[]> = {};
  for (const list of byCase.values()) {
    for (let i = 0; i < list.length - 1; i++) {
      const cur = list[i];
      const next = list[i + 1];
      // A new run starts at `next`: the gap spans idle time, not work.
      if (next.run_id !== cur.run_id || next.step === OPENING_STEP) continue;
      const d = msOf(next.ts) - msOf(cur.ts);
      if (!cur.step || !Number.isFinite(d) || d < 0) continue;
      (out[cur.step] ??= []).push(d);
    }
  }
  return out;
}

/**
 * Each stage's share of summed stage time.
 *
 * This is the disclosure that keeps a published retrieval percentile honest: on Track B the
 * measured split is reason 45.0%, tool 30.4%, govern 16.1%, retrieve 7.6%, graph 0.5% — so a
 * case-level number is mostly LLM time, and quoting one as a database figure would be wrong.
 */
export function buildStageShare(durations: Record<string, number[]>): Record<string, number> | null {
  const totals = Object.entries(durations).map(([k, v]) => [k, v.reduce((a, b) => a + b, 0)] as const);
  const grand = totals.reduce((s, [, v]) => s + v, 0);
  if (!grand) return null;
  return Object.fromEntries(totals.map(([k, v]) => [k, Number((v / grand).toFixed(4))]));
}

/**
 * Which collections the scorecard/latency/audit counts come from (working vs. immutable replay),
 * plus the corpus size the recording was produced against when replaying one.
 */
export interface StatsSource {
  events: string;
  analysis: string;
  audit: string;
  /**
   * Corpus size recorded WITH the recording, used for `counts.transactions` in demo mode.
   *
   * A replay reports the run it is replaying. Every other number here already comes from the
   * `replay_*` copies; this was the last one still counted off the local cluster, so a recorded
   * 1M run replayed on a small cluster reported the small cluster and understated itself. Undefined
   * in live mode and for pre-`replay_meta` artifacts, both of which fall back to the live count.
   */
  recordedCorpusSize?: number;
  /** Decided-precedent count from the same recording. Travels with `recordedCorpusSize` or not at
   *  all — the two sit side by side in the status bar and must describe one cluster. */
  recordedPrecedents?: number;
}
const DEFAULT_SOURCE: StatsSource = { events: 'agent_events', analysis: 'case_analysis', audit: 'audit_trail' };

/**
 * Gather the live snapshot from the cluster. Every number is a real count/measurement. `src` names
 * the collections the recorded-run metrics come from — the working ones in live mode, the frozen
 * `replay_*` copies in demo mode (so the scorecard reflects the recording, not a cleared run).
 */
export async function gatherStats(db: Db, src: StatsSource = DEFAULT_SOURCE): Promise<StatsSnapshot> {
  const tx = db.collection('transactions');
  const [liveTransactions, livePrecedents, pending, policies, auditEvents, agentEvents, investigated] = await Promise.all([
    tx.estimatedDocumentCount(),
    tx.countDocuments({ status: { $in: [...DECIDED_STATUSES] } }),
    tx.countDocuments({ status: 'pending' }),
    db.collection('policies').countDocuments({}),
    db.collection(src.audit).countDocuments({}),
    db.collection(src.events).estimatedDocumentCount(),
    db.collection(src.analysis).countDocuments({}),
  ]);

  const rows = await db.collection(src.analysis)
    .find({}, { projection: { _id: 0, transaction_id: 1, lane: 1, 'decision.disposition': 1 } })
    .toArray();
  const scorecard = buildScorecard(rows.map(r => ({
    transaction_id: r.transaction_id as string, lane: r.lane as string,
    disposition: (r as any).decision?.disposition as string,
  })));

  // Ascending `ts` is REQUIRED: caseSpansMs closes a span when it sees the next run's opening
  // event, so out-of-order input would fabricate spans. Project only what a span needs.
  const events = await db.collection(src.events)
    .find({ transaction_id: { $nin: ['', null] } },
      { projection: { _id: 0, transaction_id: 1, step: 1, ts: 1, run_id: 1 } })
    .sort({ ts: 1 })
    .toArray();
  const latency = medianCaseSpanMs(caseSpansMs(events as unknown as SpanEvent[]));

  const stageDurations = stageDurationsMs(events as unknown as SpanEvent[]);
  const stages = Object.fromEntries(
    Object.entries(stageDurations)
      .map(([k, v]) => [k, buildStagePercentiles(v)] as const)
      .filter(([, v]) => v !== null),
  ) as Record<string, StagePercentiles>;

  // Prefer the recorded corpus when replaying; the `??` fallbacks cover live mode and artifacts
  // exported before the recording carried its provenance.
  const transactions = src.recordedCorpusSize ?? liveTransactions;
  const precedents = src.recordedPrecedents ?? livePrecedents;

  return {
    counts: {
      transactions, precedents, pending, policies,
      audit_events: auditEvents, agent_events: agentEvents, investigated,
    },
    scorecard,
    latency_p50_ms: latency,
    stages: Object.keys(stages).length ? stages : null,
    stage_share: buildStageShare(stageDurations),
    generated_at: new Date().toISOString(),
  };
}
