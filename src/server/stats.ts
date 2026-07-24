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

/** Which collections the scorecard/latency/audit counts come from (working vs. immutable replay). */
export interface StatsSource { events: string; analysis: string; audit: string }
const DEFAULT_SOURCE: StatsSource = { events: 'agent_events', analysis: 'case_analysis', audit: 'audit_trail' };

/**
 * Gather the live snapshot from the cluster. Every number is a real count/measurement. `src` names
 * the collections the recorded-run metrics come from — the working ones in live mode, the frozen
 * `replay_*` copies in demo mode (so the scorecard reflects the recording, not a cleared run).
 */
export async function gatherStats(db: Db, src: StatsSource = DEFAULT_SOURCE): Promise<StatsSnapshot> {
  const tx = db.collection('transactions');
  const [transactions, precedents, pending, policies, auditEvents, agentEvents, investigated] = await Promise.all([
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

  return {
    counts: {
      transactions, precedents, pending, policies,
      audit_events: auditEvents, agent_events: agentEvents, investigated,
    },
    scorecard,
    latency_p50_ms: latency,
    generated_at: new Date().toISOString(),
  };
}
