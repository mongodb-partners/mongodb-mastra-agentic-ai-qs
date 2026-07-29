import { describe, it, expect, vi } from 'vitest';
import { Mastra } from '@mastra/core';
import {
  CASE_WORKFLOW_ID, createCaseWorkflow, runCaseWorkflow, type CaseDeps,
  QUEUE_WORKFLOW_ID, createQueueWorkflow, runQueueWorkflow, queueContext, type QueueDeps,
} from './case-workflow';

/**
 * The whole per-case graph, run against fakes — no cluster, no model.
 *
 * The point of these tests is the ORCHESTRATION: which legs overlap, what order events are emitted
 * in, and what the hard lane skips. The ledger writes underneath are already covered by
 * investigate.test.ts and case-store.test.ts, so the fake db here only has to be transactional
 * enough for `commitCaseDecision` to run.
 */
function fakeDb() {
  const writes: Record<string, any[]> = {};
  const db: any = {
    collection: (name: string) => {
      writes[name] ??= [];
      return {
        insertOne: async (doc: any) => writes[name].push({ op: 'insert', doc }),
        updateOne: async (filter: any, update: any) => writes[name].push({ op: 'update', filter, update }),
        replaceOne: async (filter: any, doc: any) => writes[name].push({ op: 'replace', filter, doc }),
        find: () => ({ sort: () => ({ limit: () => ({ next: async () => null }) }) }),
      };
    },
    client: { withSession: async (fn: any) => fn({ withTransaction: async (t: any) => t() }) },
  };
  return { db, writes };
}

// 3200 on purpose: below the structuring threshold, so the DEFAULT case auto-commits and any test
// that observes a hold is observing the reason it set up, not `must_escalate` on the amount.
const txnDoc = (over: Record<string, any> = {}) => ({
  transaction_id: 'txn-1', amount: 3200, lane: 'standard', text: 'wire to a shell company',
  sender: { account_number: 'ACC-1' }, recipient: { account_number: 'ACC-2' },
  ...over,
});

interface Harness {
  deps: CaseDeps;
  emitted: { step: string; headline: string }[];
  analysis: Record<string, unknown>[];
  toolWrites: string[];
  timeline: string[];
  startedGates: unknown[];
}

/**
 * Build a full deps bundle. `legMs` lets a test control how long each parallel leg takes, which is
 * how the ordering contract is proven: the assertions must hold with the legs finishing in ANY order.
 */
function harness(opts: {
  txn?: Record<string, any>;
  legMs?: { retrieve?: number; reason?: number; graph?: number };
  hybrid?: any[];
  ring?: Record<string, unknown>;
  verdict?: Record<string, unknown>;
  gov?: Record<string, unknown>;
  toolEvents?: any[];
  throwIn?: 'retrieve' | 'reason' | 'graph';
} = {}): Harness {
  const { db } = fakeDb();
  const emitted: Harness['emitted'] = [];
  const analysis: Record<string, unknown>[] = [];
  const toolWrites: string[] = [];
  const timeline: string[] = [];
  const startedGates: unknown[] = [];
  const ms = { retrieve: 0, reason: 0, graph: 0, ...opts.legMs };
  const hits = opts.hybrid ?? [
    { transaction_id: 'p1', status: 'approved', lane: 'standard' },
    { transaction_id: 'p2', status: 'rejected', lane: 'standard' },
    { transaction_id: 'p3', status: 'approved', lane: 'standard' },
  ];
  const sleep = async (n: number) => { if (n) await new Promise(r => setTimeout(r, n)); };

  const deps = {
    db, cfg: { auditSecret: 's' } as any, txn: opts.txn ?? txnDoc(), run_id: 'run-1',
    svc: {
      hybrid: async () => {
        timeline.push('retrieve:start'); await sleep(ms.retrieve);
        if (opts.throwIn === 'retrieve') throw new Error('hybrid exploded');
        timeline.push('retrieve:end'); return hits;
      },
      traceFundsGraph: async () => {
        timeline.push('graph:start'); await sleep(ms.graph);
        if (opts.throwIn === 'graph') throw new Error('graph exploded');
        timeline.push('graph:end');
        return { suspicious_patterns: false, network_size: 2, trace_status: 'complete', edges: [], ...opts.ring };
      },
    } as any,
    agent: {} as any,
    judge: {} as any,
    store: {} as any,
    embedQuery: async () => [0.1],
    emit: async (e: any) => { emitted.push({ step: e.step, headline: e.headline }); },
    writeToolEvents: async (id: string, evs: any[]) => { toolWrites.push(`${id}:${evs.length}`); },
    writeAnalysis: async (doc: any) => { analysis.push(doc); },
    startGate: async (input: unknown) => { startedGates.push(input); return 'run-7'; },
  } as unknown as CaseDeps;

  // The agent and the policy judge are reached through module functions, not through deps, so they
  // are stubbed at the module boundary — the same boundary run-engine crosses in production.
  vi.mocked(runInvestigationMock).mockImplementation(async () => {
    timeline.push('reason:start'); await sleep(ms.reason);
    if (opts.throwIn === 'reason') throw new Error('model exploded');
    timeline.push('reason:end');
    return { recommendation: 'approve', confidence: 96, risk_factors: ['none'], rationale: 'clean', ...opts.verdict } as any;
  });
  vi.mocked(reviewActionMock).mockImplementation(async (...args: any[]) => {
    timeline.push(`govern:${args[3]}`);
    return { compliance_score: 0.9, violations: [], held: false, dropped_citations: [], retrieved: [], ...opts.gov } as any;
  });
  vi.mocked(drainMock).mockImplementation(() => (opts.toolEvents ?? [{ tool: { name: 'hybrid_search' }, capabilities: ['hybrid'] }]) as any);

  return { deps, emitted, analysis, toolWrites, timeline, startedGates };
}

// Hoisted stubs for the two dependencies the steps import directly.
const { runInvestigationMock, reviewActionMock, drainMock } = vi.hoisted(() => ({
  runInvestigationMock: vi.fn(), reviewActionMock: vi.fn(), drainMock: vi.fn(),
}));
vi.mock('../mastra/investigation-agent', () => ({
  runInvestigation: runInvestigationMock, buildInvestigationAgent: vi.fn(),
}));
vi.mock('../governance/reviewer', () => ({ reviewAction: reviewActionMock }));
vi.mock('../mastra/tool-recorder', () => ({
  ToolCallRecorder: class { drain() { return drainMock(); } },
  TOOL_OPERATORS: {},
}));

const mastraFor = () => new Mastra({
  workflows: { [CASE_WORKFLOW_ID]: createCaseWorkflow() }, logger: false as never,
});

describe('the per-case step graph', () => {
  it('emits retrieve → recall → reason → graph → govern in that order, whatever order the legs finish in', async () => {
    // The theater scans FORWARD from the just-completed stage (public/app.js:314), so an out-of-order
    // step event lights a stage the pipeline has not reached. The fund trace finishes ~1000x faster
    // than the model, so per-leg emission would put `graph` first on every real case — this asserts
    // the join re-serializes them.
    const h = harness({ legMs: { retrieve: 30, reason: 10, graph: 1 } });
    await runCaseWorkflow(mastraFor(), h.deps);
    expect(h.emitted.map(e => e.step)).toEqual(['triage', 'retrieve', 'recall', 'reason', 'graph', 'govern', 'commit']);
    // …and the legs really did overlap: graph finished before retrieve even though it is emitted after.
    expect(h.timeline.indexOf('graph:end')).toBeLessThan(h.timeline.indexOf('retrieve:end'));
  });

  it('actually runs the three legs concurrently', async () => {
    // All three start before any finishes. Without this, `.parallel()` could be silently serializing
    // and every ordering assertion above would still pass.
    const h = harness({ legMs: { retrieve: 20, reason: 20, graph: 20 } });
    await runCaseWorkflow(mastraFor(), h.deps);
    const starts = ['retrieve:start', 'reason:start', 'graph:start'].map(s => h.timeline.indexOf(s));
    const firstEnd = Math.min(...['retrieve:end', 'reason:end', 'graph:end'].map(s => h.timeline.indexOf(s)));
    for (const s of starts) expect(s).toBeLessThan(firstEnd);
  });

  it('writes the tool events BEFORE the reason event', async () => {
    // Tool calls are how the verdict was reached; in live mode the change stream delivers them in
    // insertion order, so they have to land ahead of the verdict they explain.
    const h = harness({ toolEvents: [{ tool: { name: 'a' } }, { tool: { name: 'b' } }] });
    let reasonSeenAt = -1;
    const origEmit = h.deps.emit;
    h.deps.emit = async (e: any) => { if (e.step === 'reason') reasonSeenAt = h.toolWrites.length; return origEmit(e); };
    await runCaseWorkflow(mastraFor(), h.deps);
    expect(h.toolWrites).toEqual(['txn-1:2']);
    expect(reasonSeenAt).toBe(1); // the tool write had already happened
  });

  it('queries policies with the agent\'s disposition, so govern cannot move into the parallel block', async () => {
    const h = harness({ verdict: { recommendation: 'reject' } });
    await runCaseWorkflow(mastraFor(), h.deps);
    // The query text does not exist until the model has answered — this is the data dependency that
    // keeps `govern` sequential after `reason`.
    expect(h.timeline).toContain('govern:Disposition reject for txn-1: wire to a shell company');
  });

  it('holds a case and opens the durable gate when governance holds', async () => {
    const h = harness({ gov: { held: true, compliance_score: 0.4 } });
    await runCaseWorkflow(mastraFor(), h.deps);
    expect(h.emitted.map(e => e.step)).toEqual(['triage', 'retrieve', 'recall', 'reason', 'graph', 'govern', 'suspend']);
    expect(h.startedGates).toHaveLength(1);
    expect(h.analysis[0].phase).toBe('suspended');
    expect(h.analysis[0].evidence_hash).toBeTypeOf('string');
  });

  it('stores the full evidence projection the case-detail view reads', async () => {
    const h = harness();
    await runCaseWorkflow(mastraFor(), h.deps);
    const a = h.analysis[0] as any;
    expect(h.analysis).toHaveLength(1);
    expect(a.precedents).toHaveLength(3);
    expect(a.memory).toHaveLength(2);          // top 2 precedents only
    expect(a.ring.trace_status).toBe('complete');
    expect(a.verdict.recommendation).toBe('approve');
    expect(a.tool_calls).toEqual([{ name: 'hybrid_search' }]);
    // The raw amount is passed through untouched — a migrated collection stores Decimal128 and the
    // case-detail view formats whatever it is given.
    expect(a.amount).toBe(3200);
    expect(a.capabilities).toEqual(expect.arrayContaining(['hybrid', 'vector', 'fulltext', 'graph', 'memory', 'governance', 'durable', 'audit']));
  });

  it('reports an inconclusive fund trace as inconclusive, never as clean', async () => {
    const h = harness({ ring: { trace_status: 'account_not_found' } });
    await runCaseWorkflow(mastraFor(), h.deps);
    const graph = h.emitted.find(e => e.step === 'graph')!;
    expect(graph.headline).toBe('Fund-trace inconclusive');
  });

  it('skips `recall` when retrieval found nothing, matching the pre-graph pipeline', async () => {
    const h = harness({ hybrid: [] });
    await runCaseWorkflow(mastraFor(), h.deps);
    expect(h.emitted.map(e => e.step)).toEqual(['triage', 'retrieve', 'reason', 'graph', 'govern', 'commit']);
  });
});

describe('the hard-compliance lane', () => {
  it('bails after triage: no model call, no policy judge, no parallel legs', async () => {
    const h = harness({ txn: txnDoc({ lane: 'sanctions', amount: 1000 }) });
    await runCaseWorkflow(mastraFor(), h.deps);
    // triage → govern → commit, exactly as before the graph existed. The theater's forward scan
    // depends on this shape: it jumps straight to govern without lighting retrieve.
    expect(h.emitted.map(e => e.step)).toEqual(['triage', 'govern', 'commit']);
    // The important negative: the LLM was never consulted, so no tokens and no chance of a model
    // talking its way past a hard rule.
    expect(h.timeline).toEqual([]);
    expect(h.startedGates).toEqual([]);
    expect(h.analysis[0].phase).toBe('committed');
    expect((h.analysis[0] as any).decision.decided_by).toBe('compliance');
  });

  it('commits the hard reject even when the case would otherwise be held', async () => {
    // A governance hold must not suspend a terminal compliance reject — and in this lane the policy
    // judge never runs at all, so there is nothing that could.
    const h = harness({ txn: txnDoc({ lane: 'sanctions' }), gov: { held: true } });
    await runCaseWorkflow(mastraFor(), h.deps);
    expect(h.emitted.at(-1)!.step).toBe('commit');
  });
});

describe('failure surfaces to the caller', () => {
  for (const leg of ['retrieve', 'reason', 'graph'] as const) {
    it(`throws when the ${leg} leg fails, so the queue's per-case guard can record it`, async () => {
      // Measured: a throwing step lets its parallel siblings finish but the RUN reports `failed`.
      // runCaseWorkflow must therefore check the status rather than just awaiting start() — otherwise
      // a case that never reached a decision would be counted as investigated.
      const h = harness({ throwIn: leg });
      await expect(runCaseWorkflow(mastraFor(), h.deps)).rejects.toThrow(/case workflow failed/);
      expect(h.analysis).toEqual([]);        // nothing stored
      expect(h.emitted.map(e => e.step)).toEqual(['triage']);  // and no half-pipeline on the timeline
    });
  }

  it('throws rather than silently no-opping when the deps never arrived', async () => {
    const m = mastraFor();
    const run = await m.getWorkflow(CASE_WORKFLOW_ID).createRun();
    const res: any = await run.start({ inputData: { transaction_id: 'txn-1' } } as never);
    expect(res.status).toBe('failed');
  });
});

describe('the pending queue', () => {
  const three = () => [
    txnDoc({ transaction_id: 'txn-a' }),
    txnDoc({ transaction_id: 'txn-b' }),
    txnDoc({ transaction_id: 'txn-c' }),
  ];

  /**
   * A queue over several transactions.
   *
   * `failIds` makes specific CASES fail while the queue itself stays healthy — the distinction the
   * whole design turns on. Retrieval is what throws, keyed off which case is in flight; at
   * concurrency 1 that is unambiguous, and asserting it stays unambiguous is one of the tests below.
   */
  function queueHarness(txns: Record<string, any>[], opts: { failIds?: string[] } = {}) {
    const h = harness({ txn: txns[0] });
    const errors: { id: string; err: string }[] = [];
    const seen: { step: string; id: string }[] = [];
    const fail = new Set(opts.failIds ?? []);
    let inFlight = '';

    const deps = {
      ...(h.deps as any),
      pending: txns,
      onCaseError: async (id: string, err: unknown) => { errors.push({ id, err: String(err) }); },
      emit: async (e: any) => {
        // `triage` is the first event of a case, so it marks which case the shared fakes belong to.
        if (e.step === 'triage') inFlight = e.transaction_id;
        seen.push({ step: e.step, id: e.transaction_id });
      },
    } as QueueDeps;
    (deps as any).svc = {
      ...(h.deps as any).svc,
      hybrid: async () => {
        if (fail.has(inFlight)) throw new Error(`retrieval exploded for ${inFlight}`);
        return [{ transaction_id: 'p1', status: 'approved', lane: 'standard' }];
      },
    };
    return { deps, errors, seen, ids: () => seen.filter(e => e.step === 'triage').map(e => e.id) };
  }

  const mastraForQueue = () => new Mastra({
    workflows: { [CASE_WORKFLOW_ID]: createCaseWorkflow(), [QUEUE_WORKFLOW_ID]: createQueueWorkflow() },
    logger: false as never,
  });

  it('investigates every pending case, in the queue\'s order, and counts them', async () => {
    const q = queueHarness(three());
    expect(await runQueueWorkflow(mastraForQueue(), q.deps)).toBe(3);
    expect(q.errors).toEqual([]);
    expect(q.ids()).toEqual(['txn-a', 'txn-b', 'txn-c']);
  });

  it('runs the cases ONE AT A TIME', async () => {
    // concurrency: 1 is load-bearing, not a default. Above 1, public/app.js:372 re-points the active
    // theater case on any transaction_id change, so interleaved cases would thrash the demo's central
    // visual mid-pipeline. Serial execution also keeps the event order identical to the hand-written
    // loop this replaced, which is what leaves the replay `ts` contract and replay-fixtures.test.ts
    // untouched. Asserting per-case contiguity is how that stays true if someone raises the number.
    const q = queueHarness(three());
    await runQueueWorkflow(mastraForQueue(), q.deps);
    const ids = q.seen.map(e => e.id);
    expect([...new Set(ids)]).toEqual(['txn-a', 'txn-b', 'txn-c']); // opened in order
    for (const id of ['txn-a', 'txn-b', 'txn-c']) {
      const at = ids.flatMap((x, i) => (x === id ? [i] : []));
      // One uninterrupted block per case: no case emits while another is mid-pipeline.
      expect(at[at.length - 1] - at[0]).toBe(at.length - 1);
    }
  });

  it('keeps going after a case fails, and counts only the cases that decided', async () => {
    // THE reason queueItemStep wraps the case graph instead of being it. Measured on @mastra/core
    // 1.53.0: at concurrency 1 an item step that throws does not merely mark the run `failed`, it
    // ABANDONS THE REMAINING ITEMS — a four-case probe with the third throwing never started the
    // fourth. That is exactly the failure this queue exists to prevent, so the guard must be inside
    // the item, and this test is what proves the guard is still there.
    const q = queueHarness(three(), { failIds: ['txn-b'] });
    expect(await runQueueWorkflow(mastraForQueue(), q.deps)).toBe(2);
    expect(q.ids()).toEqual(['txn-a', 'txn-b', 'txn-c']);  // txn-c ran anyway
    expect(q.errors.map(e => e.id)).toEqual(['txn-b']);
    // The reason reaches the handler that puts it on the timeline, not just "a case failed".
    expect(q.errors[0].err).toMatch(/retrieval exploded for txn-b/);
  });

  it('keeps going when EVERY case fails, and reports none investigated', async () => {
    // The degenerate end of the same property: a cluster-wide retrieval outage must still walk the
    // whole queue and report 0, rather than throwing out of the first case and looking like a crash.
    const q = queueHarness(three(), { failIds: ['txn-a', 'txn-b', 'txn-c'] });
    expect(await runQueueWorkflow(mastraForQueue(), q.deps)).toBe(0);
    expect(q.errors.map(e => e.id)).toEqual(['txn-a', 'txn-b', 'txn-c']);
  });

  it('reports 0 for an empty queue instead of failing', async () => {
    // A reset cluster, or a second run with nothing left pending. The route logs {investigated} either
    // way, so this path has to be a number and not an exception.
    const q = queueHarness([]);
    expect(await runQueueWorkflow(mastraForQueue(), q.deps)).toBe(0);
    expect(q.seen).toEqual([]);
  });

  it('surfaces a broken QUEUE rather than quietly reporting nothing investigated', async () => {
    // Per-case failures are caught in the item step, so a failed run means the queue itself broke —
    // here, deps that never arrived. Mapping that to 0 would be indistinguishable from an empty
    // pending set, i.e. a silent no-op run.
    const q = queueHarness(three());
    const m = mastraForQueue();
    (m.getWorkflow(QUEUE_WORKFLOW_ID) as any).createRun = async () => ({
      start: async () => ({ status: 'failed', error: { message: 'snapshot store unreachable' } }),
    });
    await expect(runQueueWorkflow(m, q.deps)).rejects.toThrow(/queue workflow failed: snapshot store unreachable/);
  });

  it('refuses to investigate a case whose document is not in the pending set', async () => {
    // The graph's input carries ids only; the documents travel in the deps. A mismatch is a bug, and
    // it must not silently investigate the case with some other transaction's facts — so the lookup
    // throws OUTSIDE the guard, failing the run rather than being recorded as one failed case.
    const q = queueHarness(three());
    const m = mastraForQueue();
    const run = await m.getWorkflow(QUEUE_WORKFLOW_ID).createRun();
    const res: any = await run.start({
      inputData: [{ transaction_id: 'txn-nope' }],
      requestContext: queueContext(q.deps),
    } as never);
    expect(res.status).toBe('failed');
    // For the RIGHT reason: the deps did arrive and the lookup is what refused. Without this the test
    // would pass just as happily on a requestContext that never propagated.
    expect(String(res.error?.message ?? res.error)).toMatch(/could not find transaction txn-nope/);
    expect(q.errors).toEqual([]);   // not a per-case failure
    expect(q.seen).toEqual([]);     // and nothing was investigated
  });
});
