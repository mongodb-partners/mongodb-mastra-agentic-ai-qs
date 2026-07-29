import type { Db } from 'mongodb';
import type { MongoDBVector } from '@mastra/mongodb';
import type { Config } from '../config';
import { RetrievalService } from '../retrieval/service';
import { buildInvestigationAgent } from '../mastra/investigation-agent';
import { buildPolicyJudge } from '../governance/judge';
import type { Mastra } from '@mastra/core';
import { type StartGate } from './investigate';
import { CASES_COLLECTION, DECISIONS_COLLECTION, REVIEWS_COLLECTION } from './case-store';
import { AUDIT_COLLECTION } from '../governance/audit-store';
import { createWorkflowMastra, startReviewGate, WORKFLOW_SNAPSHOT_COLLECTION } from './review-workflow';
import { runQueueWorkflow } from './case-workflow';
import { getQueryEmbedder } from '../mastra/embed';
import { createVectorStore } from '../retrieval/vector-store';
import { TRANSACTIONS_COLLECTION } from '../mastra/schemas/transactions';
import { logger } from '../observability/logger';
import type { ToolCallEvent } from '../mastra/tool-recorder';

export const AGENT_EVENTS_COLLECTION = 'agent_events';
export const CASE_ANALYSIS_COLLECTION = 'case_analysis';

/**
 * Everything one run writes, and therefore everything that must be cleared to reset run state.
 *
 * ONE list, imported by both resetters — the live-mode reset in `routes.ts` and `bake-replay.ts` —
 * because they drifted the moment the workflow snapshot was added: the route learned about
 * `mastra_workflow_snapshot`, the bake script did not. That drift is silent and it lands on the
 * script that must be deterministic. Since Stage 1, `runPendingInvestigations` starts a suspended
 * run per held case, so clearing `reviews` while leaving the snapshots behind accumulates runs
 * suspended on cases that no longer exist — un-resumable (the resolve route reads `reviews` first)
 * and invisible in the UI, i.e. exactly the orphaned state the workflows engine is meant to prevent.
 *
 * `transactions` is NOT here: a reset restores seed *statuses* rather than deleting the corpus,
 * which at 1M would delete ~998,800 synthetic documents. The `replay_*` copies are not here either
 * — they are immutable and demo mode reads only them.
 */
export const RUN_STATE_COLLECTIONS = [
  CASES_COLLECTION, DECISIONS_COLLECTION, REVIEWS_COLLECTION, AUDIT_COLLECTION,
  AGENT_EVENTS_COLLECTION, CASE_ANALYSIS_COLLECTION, WORKFLOW_SNAPSHOT_COLLECTION,
] as const;

/** The MongoDB capabilities each investigation exercises — surfaced to the UI capability rail. */
export type Capability = 'vector' | 'fulltext' | 'hybrid' | 'graph' | 'memory' | 'governance' | 'durable' | 'audit';

async function emit(db: Db, e: { transaction_id: string; step: string; headline: string; detail?: string; capabilities?: Capability[]; run_id?: string }) {
  // `capabilities` is the set of MongoDB jobs this step exercised (an event can hit several —
  // hybrid search runs vector + full-text + fusion). The rail counts across this array.
  await db.collection(AGENT_EVENTS_COLLECTION).insertOne({ ...e, capability: e.capabilities?.[0], ts: new Date() });
}

/**
 * Shape one recorded tool call into an `agent_events` document.
 *
 * Deliberately NOT routed through emit(): emit() stamps `ts: new Date()`, which is write time, and
 * these events are written as a batch after the verdict returns. Their recorded `ts` is the real
 * completion instant, and the replay paces off `ts` deltas — overwriting it would collapse every
 * tool call in a case into one frame.
 */
export function toolEventDoc(run_id: string, transaction_id: string, e: ToolCallEvent) {
  const cap = e.capabilities?.[0];
  return {
    run_id, transaction_id,
    step: e.step, headline: e.headline, detail: e.detail,
    ...(e.capabilities ? { capabilities: e.capabilities } : {}),
    ...(cap ? { capability: cap } : {}),
    tool: e.tool,
    ts: e.ts,
  };
}

/**
 * Tag for the batch of events one `runPendingInvestigations` call produces. `agent_events` is only
 * cleared by a reset, so without this the same case investigated in two runs is indistinguishable
 * from one very slow case — which is exactly how `latency_p50_ms` came to report 290 s for cases
 * that took 7 s (see caseSpansMs in server/stats.ts). Wall-clock + a random suffix, because two
 * runs can start inside the same millisecond and the value only needs to be distinct, not ordered.
 */
function newRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Investigate every PENDING transaction with the real pipeline, one at a time, emitting a step
 * event at each stage AND persisting a rich case_analysis document (precedents, ring graph,
 * policies, verdict, decision, capabilities exercised) so the UI's case-detail view is a pure
 * projection of stored data.
 */
export async function runPendingInvestigations(db: Db, cfg: Config): Promise<{ investigated: number; run_id: string }> {
  // ONE store for the whole run, closed when the run ends.
  //
  // `createVectorStore` opens a full MongoClient with its own connection pool (the library bundles
  // its own driver), so the two things to avoid are constructing one per case — 50 pending
  // transactions would open 50 pools — and holding one for the life of the process, which leaks a
  // pool because the server has no shutdown hook to close it in. A run is the natural scope: it is
  // serialized by `runInFlight` in routes.ts, so at most one exists at a time, and the `finally`
  // below returns the pool whether the queue completes or throws.
  const store = await createVectorStore(cfg, 'marshal-retrieval');
  try {
    // The workflow instance needs no matching teardown: its snapshot store runs on the app's OWN v6
    // client through a ConnectorHandler, so it holds no pool of its own (see review-workflow.ts).
    // Its only I/O is creating the snapshot collection in the background, which fails harmlessly
    // where it cannot write — so this is safe even on the offline bake path.
    return await runQueue(db, cfg, store, createWorkflowMastra(db));
  } finally {
    // A pool this fails to return is worth a log line, not a failed run: the queue's work is already
    // committed by here, and rethrowing would replace a real result (or a real error) with a
    // teardown error.
    await store.disconnect().catch(err => {
      logger.warn('retrieval store did not disconnect cleanly', { err: String(err) });
    });
  }
}

async function runQueue(db: Db, cfg: Config, store: MongoDBVector, mastra: Mastra): Promise<{ investigated: number; run_id: string }> {
  // Held cases get a durable suspended workflow run alongside the authoritative `reviews` write.
  // Best-effort: startReviewGate swallows its own failures and returns undefined, so a snapshot-store
  // problem costs the durable pause, never the held case.
  const startGate: StartGate = input => startReviewGate(mastra, db, cfg.auditSecret, input);
  const emb = getQueryEmbedder(cfg);
  const svc = new RetrievalService(db, store, t => emb.embedQuery(t));
  const agent = buildInvestigationAgent(cfg, svc);
  const judge = buildPolicyJudge(cfg);

  const pending = await db.collection(TRANSACTIONS_COLLECTION)
    .find({ status: 'pending' }, { projection: { embedding: 0 } })
    .sort({ amount: -1 }).toArray();

  // Stamped on every event this run emits so per-case latency can tell "investigated twice" from
  // "took nine minutes". Bind it once here, not per case.
  const run_id = newRunId();
  logger.info('investigation run starting', { run_id, pending: pending.length });

  // Hand the queue its dependencies AND its side effects. The steps decide WHAT to record; these
  // decide where it lands — which is what keeps `agent_events` written by hand with `toolEventDoc`'s
  // recorded `ts` intact, rather than the engine's idea of a timestamp, and keeps this module the only
  // place that names a collection.
  const investigated = await runQueueWorkflow(mastra, {
    db, cfg, run_id, svc, agent, judge, store, startGate,
    pending: pending as Record<string, any>[],
    embedQuery: (x: string) => emb.embedQuery(x),
    emit: (e: Parameters<typeof emit>[1]) => emit(db, e),
    writeToolEvents: async (transaction_id: string, events: ToolCallEvent[]) => {
      for (const te of events) {
        await db.collection(AGENT_EVENTS_COLLECTION).insertOne(toolEventDoc(run_id, transaction_id, te));
      }
    },
    writeAnalysis: async (doc: Record<string, unknown>) => {
      await db.collection(CASE_ANALYSIS_COLLECTION)
        .replaceOne({ transaction_id: doc.transaction_id as string }, doc, { upsert: true });
    },
    // PER-CASE ISOLATION. One bad case must not abandon the rest of the queue: anything that can throw
    // is per-transaction (a model call that never yields a valid verdict, a tool error, a single failed
    // write), and a run over 50 pending transactions must not stop at the first one and leave the
    // remainder silently untouched. Record the failure as a visible step event and continue.
    onCaseError: async (transaction_id, err) => {
      logger.error('investigation failed for transaction', { transaction_id, err: String(err) });
      await emit(db, { run_id, transaction_id, step: 'error', headline: 'Investigation failed', detail: String(err) })
        .catch(() => { /* the queue continues even if we cannot record why */ });
    },
  });
  return { investigated, run_id };
}
