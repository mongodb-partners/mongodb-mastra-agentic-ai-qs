import type { Collection, Db } from 'mongodb';
import { Mastra } from '@mastra/core';
import { RequestContext } from '@mastra/core/di';
import { MastraCompositeStore } from '@mastra/core/storage';
import { WorkflowsStorageMongoDB } from '@mastra/mongodb';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { resolveReview } from './investigate';
import {
  CASE_WORKFLOW_ID, createCaseWorkflow, QUEUE_WORKFLOW_ID, createQueueWorkflow,
} from './case-workflow';
import type { EvidenceSnapshot } from './evidence';
import { logger } from '../observability/logger';

/** The single collection the snapshot store owns. Asserted against the library's own constant. */
export const WORKFLOW_SNAPSHOT_COLLECTION = 'mastra_workflow_snapshot';

export const REVIEW_WORKFLOW_ID = 'human-review-gate';
export const REVIEW_GATE_STEP_ID = 'human-review';

/** `requestContext` keys — how the step reaches the app's Db without a module global. */
const DB_KEY = 'marshal.db';
const AUDIT_SECRET_KEY = 'marshal.auditSecret';

const SnapshotSchema = z.object({
  transaction_id: z.string(),
  proposed_disposition: z.enum(['approve', 'reject', 'escalate']),
  amount: z.number(),
  risk_factors: z.array(z.string()),
  compliance_score: z.number(),
});

/**
 * The durable human-review gate: ONE step that suspends mid-graph and resumes with a human verdict.
 *
 * WHAT THIS REPLACES, AND WHAT IT DOES NOT. Today the pause is two processes passing a document
 * through MongoDB — `enqueueReview` writes, the run ends, and a separate HTTP request picks the case
 * up minutes or days later, reconstructing context from `reviews.snapshot`. This step makes that
 * pause ONE addressable durable object with typed suspend/resume payloads. It does NOT move the
 * decision: on resume it delegates to the existing `resolveReview`, so the evidence-hash
 * re-derivation and the multi-document ACID commit stay exactly where they are. The step is a
 * durable wrapper, never a reimplementation — `reviews`/`case_decisions`/`audit_trail` remain
 * authoritative and the snapshot is advisory, because a workflow snapshot cannot join
 * `commitCaseDecision`'s transaction and is not in the hash chain.
 */
export const reviewGateStep = createStep({
  id: REVIEW_GATE_STEP_ID,
  inputSchema: z.object({
    transaction_id: z.string(),
    evidence_hash: z.string(),
    flag_reason: z.string(),
    snapshot: SnapshotSchema,
  }),
  outputSchema: z.object({
    transaction_id: z.string(),
    status: z.enum(['committed', 'rejected_stale']),
  }),
  // What a human needs in order to decide, carried in the snapshot the engine persists.
  suspendSchema: z.object({
    transaction_id: z.string(),
    evidence_hash: z.string(),
    flag_reason: z.string(),
    snapshot: SnapshotSchema,
  }),
  // What the resolve route sends back. `current` is the snapshot RE-DERIVED from live state by the
  // route (routes.ts deriveEvidenceSnapshot) — deliberately not trusted from the client, and
  // deliberately not read back off the suspend payload, because the whole point of the stale check
  // is to compare the hash captured at suspend-time against evidence as it stands NOW.
  resumeSchema: z.object({
    decision: z.enum(['approve', 'reject']),
    confidence: z.number().optional(),
    current: SnapshotSchema.optional(),
    now: z.string().optional(),
  }),
  execute: async ({ inputData, resumeData, suspend, requestContext }) => {
    if (!resumeData) {
      await suspend({
        transaction_id: inputData.transaction_id,
        evidence_hash: inputData.evidence_hash,
        flag_reason: inputData.flag_reason,
        snapshot: inputData.snapshot,
      });
      // Unreachable in practice — `suspend()` unwinds the step — but the signature must return the
      // output shape, and a bare `undefined` would fail outputSchema validation on some paths.
      return { transaction_id: inputData.transaction_id, status: 'committed' as const };
    }

    const db = requestContext?.get(DB_KEY) as Db | undefined;
    const auditSecret = requestContext?.get(AUDIT_SECRET_KEY) as string | undefined;
    if (!db || !auditSecret) {
      // Fail LOUD, not clean. Swallowing this would report a committed decision that never reached
      // the ledger — the same absence-of-evidence shape the audit chain exists to make impossible.
      throw new Error('review gate resumed without a Db in requestContext');
    }

    return {
      transaction_id: inputData.transaction_id,
      ...(await resolveReview(db, auditSecret, {
        transaction_id: inputData.transaction_id,
        human_decision: resumeData.decision,
        echoed_evidence_hash: inputData.evidence_hash,
        current: (resumeData.current ?? inputData.snapshot) as EvidenceSnapshot,
        confidence: resumeData.confidence,
        now: resumeData.now ?? new Date().toISOString(),
      })),
    };
  },
});

export function createReviewWorkflow() {
  return createWorkflow({
    id: REVIEW_WORKFLOW_ID,
    inputSchema: reviewGateStep.inputSchema,
    outputSchema: reviewGateStep.outputSchema,
  }).then(reviewGateStep).commit();
}

/** Bundle the request-scoped values the gate step needs into a `RequestContext`. */
export function gateContext(db: Db, auditSecret: string): RequestContext {
  const ctx = new RequestContext();
  ctx.set(DB_KEY, db);
  ctx.set(AUDIT_SECRET_KEY, auditSecret);
  return ctx;
}

/**
 * A `ConnectorHandler` over the app's OWN v6 `Db` — the store gets no client of its own.
 *
 * WHY NOT `{uri, dbName}`, which the library also accepts. Two reasons, both measured.
 *
 * 1. A SECOND CONNECTION POOL WITH NO WAY TO RETURN IT. Passing a uri makes the domain open its own
 *    `MongoClient` (the library bundles mongodb 7), and neither `WorkflowsStorageMongoDB` nor
 *    `MastraCompositeStore` exposes a `close()` — verified by walking both prototype chains. So a
 *    per-run store would leak a pool per run, and a probe that constructed one never exited. This
 *    handler holds no resource: the app's client is the only client, and it is already closed by
 *    the server's own lifecycle.
 * 2. NO CROSS-DRIVER BSON HAZARD. `mastra_workflow_snapshot` documents written by the bundled
 *    mongodb 7 carry bson 7 values, and bson 6 does not merely mis-handle a foreign BSON class, it
 *    REFUSES it (`BSONVersionError`) — the same trap that forced `RetrievalService.toHit` to map
 *    field-by-field instead of spreading. Reading and writing the snapshot through the app's own
 *    driver means the question never arises. Verified: a suspended run's snapshot reads back through
 *    the v6 driver, and a cold `createRun({runId})` resumes it to `success`.
 *
 * `close()` is intentionally a no-op that does NOT touch the client: the store does not own it, and
 * closing the app's pool from a storage teardown would kill every other collection with it.
 */
export function workflowConnectorHandler(db: Db) {
  return {
    async getCollection(name: string): Promise<Collection> {
      return db.collection(name);
    },
    async close(): Promise<void> {
      /* the app owns the client; nothing to release here */
    },
  };
}

/**
 * A `Mastra` instance whose storage is the workflows domain and NOTHING else.
 *
 * WHY THE COMPOSITE STORE, and not `new MongoDBStore(...)`. Measured: a plain `MongoDBStore` creates
 * **31 collections** on first use — `mastra_agents`, `mastra_threads`, `mastra_datasets`,
 * `mastra_scorers` and 27 more, all empty, none of which this app has any use for. That is
 * unacceptable on a cluster whose entire demo story is "one cluster, these collections": a presenter
 * opening Atlas would find the app's eight real collections buried in framework scaffolding. A
 * composite store with a single `workflows` domain creates exactly **one**, and the library declares
 * which one via `WorkflowsStorageMongoDB.MANAGED_COLLECTIONS`, asserted in the tests rather than
 * hardcoded here.
 *
 * Construction is SYNCHRONOUSLY clean but not I/O-free, and the difference matters. Measured on the
 * box against real Atlas: nothing has touched the database when this returns, and then ~107 ms later
 * the engine creates and indexes `mastra_workflow_snapshot` on its own. So a freshly provisioned
 * cluster shows the collection, empty, from app boot onward — an empty snapshot collection means
 * "nothing is paused", not "the gate was never wired up".
 *
 * That background write is why this is still safe on the read-only paths. Verified with a `read`-only
 * user (Track A's shape): the creation fails, the failure is swallowed inside the engine, the process
 * does NOT crash and no unhandled rejection escapes — a DEMO_MODE server booted on that user serves
 * `/api/health` and `/api/cases` normally. Demo mode never suspends a run, so the collection it could
 * not create is one it would never read. The offline Docker bake is safe for the same reason.
 */
export function createWorkflowMastra(db: Db) {
  const workflows = new WorkflowsStorageMongoDB({
    connectorHandler: workflowConnectorHandler(db),
  } as never);
  const storage = new MastraCompositeStore({
    id: 'marshal-workflows',
    domains: { workflows },
  } as never);
  return new Mastra({
    storage,
    // Both workflows on ONE instance, sharing the one snapshot store. Registration is a map entry and
    // nothing more — no I/O, no collection — so the resolve route registering the case graph it never
    // runs costs nothing, and in exchange there is a single place where a workflow becomes reachable.
    workflows: {
      [REVIEW_WORKFLOW_ID]: createReviewWorkflow(),
      [CASE_WORKFLOW_ID]: createCaseWorkflow(),
      [QUEUE_WORKFLOW_ID]: createQueueWorkflow(),
    },
    // The app logs through its own structured logger; Mastra's default writes an unrelated format to
    // stdout, which on a box is the same stream the run's own log lines go to.
    logger: false as never,
  });
}

/**
 * Start a review-gate run that immediately suspends, and return its run id.
 *
 * BEST-EFFORT BY DESIGN, and this is the whole reason the caller treats it as optional. `reviews` is
 * authoritative: `enqueueReview` has already persisted the case by the time this runs. If starting
 * the run fails, the case is still held, still visible in the queue, and still resolvable through the
 * route's direct `resolveReview` fallback — i.e. it degrades to exactly today's behaviour. Throwing
 * would instead lose a held case to a snapshot-store problem, trading the authoritative record for
 * the advisory one.
 */
export async function startReviewGate(
  mastra: Mastra, db: Db, auditSecret: string,
  input: { transaction_id: string; evidence_hash: string; flag_reason: string; snapshot: EvidenceSnapshot },
): Promise<string | undefined> {
  try {
    const run = await mastra.getWorkflow(REVIEW_WORKFLOW_ID).createRun();
    const res = await run.start({
      inputData: input,
      requestContext: gateContext(db, auditSecret),
    } as never);
    if ((res as { status?: string }).status !== 'suspended') {
      logger.warn('review gate did not suspend as expected', {
        transaction_id: input.transaction_id, status: (res as { status?: string }).status,
      });
    }
    return run.runId;
  } catch (err) {
    logger.warn('could not start the durable review gate; the case is still held in `reviews`', {
      transaction_id: input.transaction_id, err: String(err),
    });
    return undefined;
  }
}

/**
 * Resume a suspended review-gate run with a human verdict, returning what the ledger did.
 *
 * Returns `undefined` when the run cannot be resumed at all (no such run, already resumed, storage
 * unreachable) so the caller can fall back to calling `resolveReview` directly. That fallback is not
 * hypothetical: a case suspended before this feature shipped has no `workflow_run_id`, and demo mode
 * never starts a run.
 */
export async function resumeReviewGate(
  mastra: Mastra, db: Db, auditSecret: string,
  args: {
    runId: string; transaction_id: string;
    decision: 'approve' | 'reject'; confidence?: number;
    current: EvidenceSnapshot; now: string;
  },
): Promise<'committed' | 'rejected_stale' | undefined> {
  try {
    const run = await mastra.getWorkflow(REVIEW_WORKFLOW_ID).createRun({ runId: args.runId });
    // `resume`, NOT `resumeAsync`: on @mastra/core 1.53.0 `resumeAsync` is fire-and-forget and
    // returns `{runId}` only (see the docstring at workflows/workflow.d.ts:571), so the HTTP handler
    // would answer before knowing whether the commit succeeded — and "committed" is the one thing it
    // must not guess about.
    const res = await run.resume({
      step: reviewGateStep,
      resumeData: {
        decision: args.decision, confidence: args.confidence,
        current: args.current, now: args.now,
      },
      requestContext: gateContext(db, auditSecret),
    } as never);
    const status = (res as { result?: { status?: string } }).result?.status;
    return status === 'committed' || status === 'rejected_stale' ? status : undefined;
  } catch (err) {
    logger.warn('could not resume the durable review gate; falling back to a direct resolve', {
      transaction_id: args.transaction_id, run_id: args.runId, err: String(err),
    });
    return undefined;
  }
}
