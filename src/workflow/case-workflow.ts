import type { Db } from 'mongodb';
import { Mastra } from '@mastra/core';
import { RequestContext } from '@mastra/core/di';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import type { MongoDBVector } from '@mastra/mongodb';
import type { Agent } from '@mastra/core/agent';
import type { Config } from '../config';
import type { RetrievalService } from '../retrieval/service';
import { reviewAction, type PolicyJudge } from '../governance/reviewer';
import { runInvestigation } from '../mastra/investigation-agent';
import { ToolCallRecorder, type ToolCallEvent } from '../mastra/tool-recorder';
import { triage, reconcile } from '../decision/core';
import { runCaseInvestigation, type StartGate } from './investigate';
import { evidenceHash, type EvidenceSnapshot } from './evidence';
import { formatMoney, moneyToNumber } from '../money';
import type { Capability } from './run-engine';

export const CASE_WORKFLOW_ID = 'case-investigation';
export const QUEUE_WORKFLOW_ID = 'investigation-queue';
export const QUEUE_ITEM_STEP_ID = 'investigate-case';

/** `requestContext` keys for the per-case and per-run dependency bundles. */
const DEPS_KEY = 'marshal.caseDeps';
const QUEUE_KEY = 'marshal.queueDeps';

/**
 * Everything one case needs, assembled once per run and handed to the graph through
 * `requestContext`.
 *
 * `txn` — the raw transaction document — travels HERE and not through the step schemas, on purpose.
 * `amount` is a Decimal128 in a migrated collection, and the step graph's inputs are serialized into
 * `mastra_workflow_snapshot` at every step boundary. Passing the raw document through the graph would
 * put BSON class instances in the snapshot and force every downstream step to re-coerce them; keeping
 * it in the context means the graph carries only JSON scalars, while `case_analysis` still writes the
 * original Decimal128 it was given.
 */
export interface CaseDeps {
  db: Db;
  cfg: Config;
  txn: Record<string, any>;
  run_id: string;
  svc: RetrievalService;
  agent: Agent;
  judge: PolicyJudge;
  store: MongoDBVector;
  embedQuery: (text: string) => Promise<number[]>;
  emit: (e: { transaction_id: string; step: string; headline: string; detail?: string; capabilities?: Capability[]; run_id?: string }) => Promise<void>;
  writeToolEvents: (transaction_id: string, events: ToolCallEvent[]) => Promise<void>;
  writeAnalysis: (doc: Record<string, unknown>) => Promise<void>;
  startGate?: StartGate;
}

export function caseContext(deps: CaseDeps): RequestContext {
  const ctx = new RequestContext();
  ctx.set(DEPS_KEY, deps);
  return ctx;
}

function depsOf(requestContext: RequestContext | undefined): CaseDeps {
  const deps = requestContext?.get(DEPS_KEY) as CaseDeps | undefined;
  // Loud, not lenient: without deps a step has no Db, no agent and no emitter, so "succeeding" would
  // mean reporting an investigated case that touched nothing.
  if (!deps) throw new Error('case workflow step ran without its deps in requestContext');
  return deps;
}

const Ref = z.object({ transaction_id: z.string() });

/** JSON-shaped payloads passed between steps. `z.any()` where the value is a stored projection whose
 *  shape is owned elsewhere (`RetrievalService` hits, the ring trace, the agent verdict) — restating
 *  those schemas here would be a second definition to keep in sync, not a safety gain. */
const Findings = z.object({
  precedents: z.array(z.any()),
  memory: z.array(z.any()),
});
const Reasoning = z.object({
  verdict: z.any(),
  tool_events: z.array(z.any()),
});
const Ring = z.object({ ring: z.any() });
const CaseOutput = z.object({
  transaction_id: z.string(),
  phase: z.enum(['committed', 'suspended']),
  lane: z.enum(['hard_compliance', 'full']),
});

/**
 * TRIAGE + the hard-compliance short-circuit, ahead of everything else.
 *
 * A sanctions/watchlist hit is a deterministic reject: no agent, no policy judge, no tokens, and no
 * opportunity for a model to talk its way past a hard rule. `bail()` returns the workflow's output
 * without running the remaining steps — verified: `status: 'success'` with the bailed payload, and
 * the following step never executes. That is the whole reason this is a `bail` rather than a
 * `.branch()`: the hard lane is not a different path through the pipeline, it is the absence of one.
 */
export const triageStep = createStep({
  id: 'triage',
  inputSchema: Ref,
  outputSchema: Ref,
  execute: async ({ inputData, bail, requestContext }) => {
    const { db, cfg, txn: t, run_id, emit, writeAnalysis } = depsOf(requestContext);
    const id = inputData.transaction_id;
    // formatMoney, not amount.toLocaleString(): Decimal128 HAS a toLocaleString and it returns a bare
    // "4950.00" with no thousands separator, which reads as a formatting regression in the demo's
    // first visible line rather than as an error.
    await emit({ run_id, transaction_id: id, step: 'triage', headline: `Investigating ${id}`, detail: `$${formatMoney(t.amount)} · ${t.lane}` });

    const facts0 = {
      transaction_id: id, amount: t.amount, sender_account: t.sender.account_number,
      lane: t.lane, sanctions_hit: t.lane === 'sanctions', ring_suspicious: false,
    };
    const hard = triage(facts0);
    if (!hard) return { transaction_id: id };

    await emit({ run_id, transaction_id: id, step: 'govern', headline: `Hard compliance: ${hard.risk_factors[0]}`, detail: 'deterministic reject — agent not consulted', capabilities: ['governance'] });
    const now = new Date().toISOString();
    await runCaseInvestigation(db, cfg.auditSecret, facts0, {
      recommendation: 'reject', confidence: 100, risk_factors: hard.risk_factors, rationale: hard.rationale,
    }, 0, false, now);
    await writeAnalysis({
      transaction_id: id, amount: t.amount, lane: t.lane, sender: t.sender, recipient: t.recipient, narrative: t.text,
      precedents: [], memory: [], ring: { edges: [] },
      governance: { compliance_score: 0, violations: [], held: false, dropped_citations: [] },
      verdict: { recommendation: 'reject', confidence: 100, risk_factors: hard.risk_factors, rationale: hard.rationale },
      tool_calls: [],
      decision: { disposition: hard.disposition, decided_by: hard.decided_by, risk_factors: hard.risk_factors, rationale: hard.rationale },
      phase: 'committed', capabilities: ['durable', 'audit'], updated_at: new Date(),
    });
    await emit({ run_id, transaction_id: id, step: 'commit', capabilities: ['durable', 'audit'], headline: 'Auto-reject (compliance)', detail: 'reject' });
    return bail({ transaction_id: id, phase: 'committed' as const, lane: 'hard_compliance' as const });
  },
});

/**
 * The three independent legs. Each does its Atlas/model work and EMITS NOTHING — see joinStep.
 *
 * They are independent in the strict sense: hybrid retrieval feeds the case-detail view and the
 * memory line, the agent never receives the precedents (verified — `runInvestigation` takes the
 * narrative and the account numbers, and does its own tool-driven retrieval), and the fund trace
 * keys off the sender account alone.
 */
export const retrieveStep = createStep({
  id: 'retrieve',
  inputSchema: Ref,
  outputSchema: Findings,
  execute: async ({ requestContext }) => {
    const { svc, txn: t } = depsOf(requestContext);
    const precedents = await svc.hybrid(t.text, 4);
    return {
      precedents,
      memory: precedents.slice(0, 2).map(p => ({ transaction_id: p.transaction_id, disposition: p.status, lane: p.lane })),
    };
  },
});

export const reasonStep = createStep({
  id: 'reason',
  inputSchema: Ref,
  outputSchema: Reasoning,
  execute: async ({ requestContext }) => {
    const { cfg, agent, txn: t } = depsOf(requestContext);
    // A fresh recorder per case. `drain()` empties it anyway, but a per-case instance also means a
    // case that throws cannot leak its calls into the next one.
    const recorder = new ToolCallRecorder();
    // The subject's accounts go WITH the narrative: narratives name parties, never account numbers,
    // so without this the agent has to invent the argument to `trace_funds` — and a fabricated
    // account traces nothing, which used to read as a clean fund-trace.
    const verdict = await runInvestigation(agent, cfg, t.text, undefined, recorder, {
      transaction_id: t.transaction_id,
      sender_account: t.sender.account_number,
      recipient_account: t.recipient?.account_number,
    });
    return { verdict, tool_events: recorder.drain() };
  },
});

export const graphStep = createStep({
  id: 'graph',
  inputSchema: Ref,
  outputSchema: Ring,
  execute: async ({ requestContext }) => {
    const { svc, txn: t } = depsOf(requestContext);
    return { ring: await svc.traceFundsGraph(t.sender.account_number) };
  },
});

/**
 * THE ORDERING BARRIER. Execution overlaps; emission must not.
 *
 * `public/app.js:314` scans FORWARD from the just-completed stage to decide which one to light as
 * in-flight, so an out-of-order step event marks a later stage done and paints a stage the pipeline
 * has not reached. The three legs above therefore stay silent and this step emits their events in the
 * pipeline's canonical order — `retrieve → recall → reason → graph` — once all three have landed. Any
 * scheme where each leg emits on its own completion breaks that contract outright: the fund trace
 * finishes in ~6 ms against the agent's ~9 s (measured mean at 1M; 5.9-13.4 s across cases), so `graph`
 * would arrive first on every case and mark reasoning complete before the model had answered.
 *
 * One honest consequence of parallelism. Tool events keep their RECORDED `ts` (the replay paces off
 * `ts` deltas, so overwriting it would collapse a case's tool calls into one frame), and the agent now
 * runs concurrently with retrieval — so a tool call's real instant can precede the `retrieve` event's
 * write time. Insertion order, which is what the live change stream delivers, stays canonical; a
 * `ts`-sorted read of a re-baked recording would show tool calls opening the case. That ordering is
 * true — the calls really did happen while retrieval was in flight — and `theaterTool` only updates
 * the now-line and the reason badge without advancing any stage, so it costs nothing structurally.
 */
export const joinStep = createStep({
  id: 'join',
  inputSchema: z.object({ retrieve: Findings, reason: Reasoning, graph: Ring }),
  outputSchema: Findings.merge(Reasoning).merge(Ring),
  execute: async ({ inputData, requestContext }) => {
    const { run_id, emit, writeToolEvents } = depsOf(requestContext);
    const { precedents, memory } = inputData.retrieve;
    const { verdict, tool_events } = inputData.reason;
    const { ring } = inputData.graph;
    const id = depsOf(requestContext).txn.transaction_id as string;

    await emit({ run_id, transaction_id: id, step: 'retrieve', headline: `${precedents.length} precedents (hybrid search)`, detail: precedents.map((p: any) => p.transaction_id).join(', '), capabilities: ['hybrid', 'vector', 'fulltext'] });
    if (memory.length) {
      await emit({ run_id, transaction_id: id, step: 'recall', headline: `Recalled ${memory.length} prior verdict(s)`, detail: memory.map((m: any) => `${m.transaction_id}→${m.disposition}`).join(', '), capabilities: ['memory'] });
    }
    // Tool events go in BEFORE the reason event and in call order — they are how the verdict was
    // reached, and in live mode the change stream delivers them in insertion order.
    await writeToolEvents(id, tool_events as ToolCallEvent[]);
    await emit({ run_id, transaction_id: id, step: 'reason', headline: `Agent: ${verdict.recommendation} · confidence ${verdict.confidence}`, detail: verdict.risk_factors[0] });

    // Three outcomes, not two. A trace that found no such account, or that ran out of memory partway,
    // has NOT established that the account is clean — reporting "Fund-trace clean" for those is a
    // false negative. This is the deterministic trace on the case's own account, so
    // 'account_not_found' means the corpus genuinely has no transaction sent from it: a data problem
    // worth seeing on the timeline, not a clean bill of health.
    const traceIncomplete = ring.trace_status !== 'complete';
    await emit({
      run_id, transaction_id: id, step: 'graph', capabilities: ['graph'],
      headline: ring.suspicious_patterns ? `Ring detected · ${ring.network_size} hops`
        : traceIncomplete ? 'Fund-trace inconclusive' : 'Fund-trace clean',
      detail: ring.suspicious_patterns ? `circular_flow=${ring.circular_flow} layering=${ring.layering}`
        : traceIncomplete ? `trace_status=${ring.trace_status}` : `network_size=${ring.network_size}`,
    });

    return { precedents, memory, verdict, tool_events, ring };
  },
});

/**
 * GOVERNANCE — sequential after `reason`, and that is a data dependency rather than an oversight.
 *
 * The policy `$vectorSearch` embeds `Disposition ${verdict.recommendation} for ${id}: ${narrative}`,
 * so the query text does not exist until the agent has answered. Moving this into the parallel block
 * would mean retrieving policies for a disposition nobody had proposed yet.
 */
export const governStep = createStep({
  id: 'govern',
  inputSchema: Findings.merge(Reasoning).merge(Ring),
  outputSchema: Findings.merge(Reasoning).merge(Ring).extend({ gov: z.any() }),
  execute: async ({ inputData, requestContext }) => {
    const { run_id, emit, store, embedQuery, judge, txn: t } = depsOf(requestContext);
    const id = t.transaction_id as string;
    const gov = await reviewAction(store, embedQuery, judge, `Disposition ${inputData.verdict.recommendation} for ${id}: ${t.text}`);
    await emit({ run_id, transaction_id: id, step: 'govern', headline: `Policy score ${gov.compliance_score}${gov.held ? ' · HELD' : ''}`, detail: gov.violations.map((v: any) => v.policy_code).join(', '), capabilities: ['governance'] });
    return { ...inputData, gov };
  },
});

/**
 * The deterministic decision, the durable gate, and the stored evidence.
 *
 * Delegates to `runCaseInvestigation` — unchanged — so the reconciler, the ACID commit and the
 * suspend-with-evidence-hash all stay exactly where they were. The step graph reorganized what runs
 * when; it did not move the ledger.
 */
export const decideStep = createStep({
  id: 'decide',
  inputSchema: Findings.merge(Reasoning).merge(Ring).extend({ gov: z.any() }),
  outputSchema: CaseOutput,
  execute: async ({ inputData, requestContext }) => {
    const { db, cfg, txn: t, run_id, emit, writeAnalysis, startGate } = depsOf(requestContext);
    const id = t.transaction_id as string;
    const { precedents, memory, verdict, tool_events, ring, gov } = inputData;

    const facts = {
      transaction_id: id, amount: t.amount, sender_account: t.sender.account_number,
      lane: t.lane, sanctions_hit: t.lane === 'sanctions', ring_suspicious: ring.suspicious_patterns,
    };
    const decision = triage(facts) ?? reconcile(facts, verdict);
    const now = new Date().toISOString();
    const snapshot: EvidenceSnapshot = {
      transaction_id: id, proposed_disposition: decision.disposition, amount: moneyToNumber(t.amount),
      risk_factors: decision.risk_factors, compliance_score: gov.compliance_score,
    };
    const out = await runCaseInvestigation(db, cfg.auditSecret, facts, verdict, gov.compliance_score, gov.held, now, startGate);

    // The capability set is derived from what actually ran, not accumulated across steps: a parallel
    // graph has no single place to mutate a shared Set safely, and every membership here is already
    // implied by the branch reaching this step.
    const caps: Capability[] = ['hybrid', 'vector', 'fulltext', 'graph', 'governance', 'durable', 'audit'];
    if (memory.length) caps.push('memory');
    for (const te of tool_events as ToolCallEvent[]) for (const c of te.capabilities ?? []) if (!caps.includes(c)) caps.push(c);

    await writeAnalysis({
      transaction_id: id, amount: t.amount, lane: t.lane,
      sender: t.sender, recipient: t.recipient, narrative: t.text,
      precedents, memory, ring, governance: gov, verdict,
      tool_calls: (tool_events as ToolCallEvent[]).map(te => te.tool),
      decision: { disposition: decision.disposition, decided_by: decision.decided_by, risk_factors: decision.risk_factors, rationale: decision.rationale },
      phase: out.phase, evidence_hash: out.evidence_hash ?? evidenceHash(snapshot),
      snapshot, capabilities: caps, updated_at: new Date(),
    });
    await emit({
      run_id, transaction_id: id, step: out.phase === 'suspended' ? 'suspend' : 'commit',
      capabilities: ['durable', 'audit'],
      headline: out.phase === 'suspended' ? 'HELD for human review' : `Auto-${out.decision.disposition}`,
      detail: out.decision.disposition,
    });
    return { transaction_id: id, phase: out.phase, lane: 'full' as const };
  },
});

/**
 * The per-case graph. `.parallel()` here buys ~0, and that is worth knowing before touching it.
 *
 * A/B measured on the Track B box, same database, alternating runs, this graph against the serial loop
 * it replaced: **42022 ms serial vs 41042 ms parallel over 6 cases, -2.3%** (n=4 each; the parallel
 * arm's spread is much wider, 8093 ms against 1536 ms, so -2.3% is inside the noise). The projection
 * that justified the parallel block said 22%. It was not a measurement error — the projection was read
 * off the baked 1M recording, where the `retrieve` leg cost 1061-7786 ms, and binary quantization has
 * since cut that to **226 ms** at the same 1M scale (see `quantizationForCorpus`). What overlaps with
 * the agent is `retrieve + recall + graph` = ~236 ms against a ~9.3 s agent leg, so the arithmetic
 * ceiling on any concurrency here is now ~2%, whoever implements it.
 *
 * KEPT ANYWAY, on the honest reason rather than the fast one. The graph is what makes the pipeline
 * inspectable — typed step boundaries, a durable snapshot per step, and a shape a reader can see — and
 * the engine cost is ~64 ms per case (2n+2 snapshot writes at the box's 4 ms upsert RTT), which the
 * ~236 ms of overlap covers. Do not reintroduce a latency claim for it; if the agent leg ever stops
 * dominating, re-run the A/B before writing a number down.
 */
export function createCaseWorkflow() {
  return createWorkflow({ id: CASE_WORKFLOW_ID, inputSchema: Ref, outputSchema: CaseOutput })
    .then(triageStep)
    .parallel([retrieveStep, reasonStep, graphStep])
    .then(joinStep)
    .then(governStep)
    .then(decideStep)
    .commit();
}

/**
 * Everything a RUN needs, minus the case. The queue step builds one `CaseDeps` per transaction by
 * adding `txn`, which is the only field that varies between cases.
 */
export type QueueDeps = Omit<CaseDeps, 'txn'> & {
  /**
   * The pending transactions, in the order they will be investigated.
   *
   * The graph's input carries only `transaction_id` — the raw documents stay here for the same reason
   * `CaseDeps.txn` does: they hold Decimal128 amounts, and a `.foreach()` input is serialized into the
   * queue run's snapshot at every item boundary.
   */
  pending: Record<string, any>[];
  /** Records a case that failed, so the queue can continue and still show why on the timeline. */
  onCaseError: (transaction_id: string, err: unknown) => Promise<void>;
};

export function queueContext(deps: QueueDeps): RequestContext {
  const ctx = new RequestContext();
  ctx.set(QUEUE_KEY, deps);
  return ctx;
}

/**
 * ONE case, guarded. The guard is the reason this step exists rather than putting the case workflow
 * straight into `.foreach()`.
 *
 * Measured on @mastra/core 1.53.0: at `concurrency: 1`, an item step that throws does not merely make
 * the run report `failed` — it ABANDONS THE REMAINING ITEMS. A four-case probe with the third throwing
 * never started the fourth. That is precisely the failure this queue was built to prevent: a run over
 * 50 pending transactions stopping at the first bad case and leaving the rest silently untouched.
 *
 * So the case graph is nested INSIDE this step and its failure is caught here. The nested run is
 * reached through the injected `mastra` (verified: the step receives the instance with both workflows
 * registered), which also means the per-case graph gets its own snapshot and run id — a failed case is
 * durably recorded as a failed run rather than vanishing.
 */
export const queueItemStep = createStep({
  id: QUEUE_ITEM_STEP_ID,
  inputSchema: z.object({ transaction_id: z.string() }),
  outputSchema: z.object({ transaction_id: z.string(), investigated: z.boolean() }),
  execute: async ({ inputData, requestContext, mastra }) => {
    const queue = requestContext?.get(QUEUE_KEY) as QueueDeps | undefined;
    if (!queue) throw new Error('queue workflow step ran without its deps in requestContext');
    const id = inputData.transaction_id;
    const txn = queue.pending.find(t => t.transaction_id === id);
    if (!txn) throw new Error(`queue step could not find transaction ${id} in the pending set`);
    try {
      await runCaseWorkflow(mastra as Mastra, { ...queue, txn });
      return { transaction_id: id, investigated: true };
    } catch (err) {
      await queue.onCaseError(id, err);
      return { transaction_id: id, investigated: false };
    }
  },
});

/**
 * The pending queue as a workflow.
 *
 * `concurrency: 1`, and not as a placeholder. Above 1, `public/app.js:372` re-points the active
 * theater case on any `transaction_id` change, so interleaved cases thrash the display — the demo's
 * central visual would flicker between cases mid-pipeline. At 1 the case ordering is identical to the
 * hand-written loop, which is what keeps the theater, the replay `ts` contract and
 * `replay-fixtures.test.ts` intact. `caseSpansMs` (stats.ts) groups by `transaction_id` before
 * splitting on run boundaries, so it would survive interleaving regardless; the theater would not.
 */
export function createQueueWorkflow() {
  return createWorkflow({
    id: QUEUE_WORKFLOW_ID,
    inputSchema: z.array(z.object({ transaction_id: z.string() })),
    outputSchema: z.array(z.object({ transaction_id: z.string(), investigated: z.boolean() })),
  }).foreach(queueItemStep, { concurrency: 1 }).commit();
}

/** Run the whole pending queue. Returns how many cases actually reached a decision. */
export async function runQueueWorkflow(mastra: Mastra, deps: QueueDeps): Promise<number> {
  const run = await mastra.getWorkflow(QUEUE_WORKFLOW_ID).createRun();
  const res = await run.start({
    inputData: deps.pending.map(t => ({ transaction_id: t.transaction_id as string })),
    requestContext: queueContext(deps),
  } as never) as { status?: string; error?: unknown; result?: { investigated?: boolean }[] };
  // Every per-case failure is caught in the item step, so a failed run here means the QUEUE itself
  // broke (bad deps, a snapshot-store outage) — worth surfacing rather than reporting 0 investigated.
  if (res.status !== 'success') {
    throw new Error(`queue workflow ${res.status ?? 'did not complete'}: ${errorText(res.error)}`);
  }
  return (res.result ?? []).filter(r => r?.investigated).length;
}

/** Run one case through the graph. Throws on failure so the caller's per-case guard can record it. */
export async function runCaseWorkflow(mastra: Mastra, deps: CaseDeps): Promise<void> {
  const run = await mastra.getWorkflow(CASE_WORKFLOW_ID).createRun();
  const res = await run.start({
    inputData: { transaction_id: deps.txn.transaction_id as string },
    requestContext: caseContext(deps),
  } as never) as { status?: string; error?: unknown };
  // A step that throws leaves the RUN reporting `failed` while its parallel siblings still complete,
  // so the status has to be checked explicitly — awaiting `start()` without this would swallow the
  // failure and count a case that never reached a decision.
  if (res.status !== 'success') {
    throw new Error(`case workflow ${res.status ?? 'did not complete'}: ${errorText(res.error)}`);
  }
}

/** Workflow errors arrive as objects whose `String()` is `[object Object]` — dig out the message. */
function errorText(err: unknown): string {
  if (!err) return 'no error reported';
  if (typeof err === 'string') return err;
  const m = (err as { message?: unknown }).message;
  return typeof m === 'string' ? m : JSON.stringify(err);
}
