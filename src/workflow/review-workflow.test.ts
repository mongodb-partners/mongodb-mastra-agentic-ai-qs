import { describe, it, expect } from 'vitest';
import { WorkflowsStorageMongoDB } from '@mastra/mongodb';
import {
  WORKFLOW_SNAPSHOT_COLLECTION, REVIEW_WORKFLOW_ID, REVIEW_GATE_STEP_ID,
  reviewGateStep, createReviewWorkflow, createWorkflowMastra,
  gateContext, workflowConnectorHandler, startReviewGate, resumeReviewGate,
} from './review-workflow';
import { CASE_WORKFLOW_ID, QUEUE_WORKFLOW_ID } from './case-workflow';
import { evidenceHash, type EvidenceSnapshot } from './evidence';
import { runCaseInvestigation } from './investigate';
import type { TxnFacts, AgentVerdict } from '../decision/core';

// Same fake transactional db as investigate.test.ts: the point of these tests is that the gate
// delegates to the REAL resolveReview/commitCaseDecision, so the assertions are about which writes
// those made — not about a mock of them.
function fakeDb() {
  const writes: Record<string, any[]> = {};
  const db: any = {
    collection: (name: string) => {
      writes[name] ??= [];
      return {
        insertOne: async (doc: any) => writes[name].push({ op: 'insert', doc }),
        updateOne: async (filter: any, update: any) => writes[name].push({ op: 'update', filter, update }),
        find: () => ({ sort: () => ({ limit: () => ({ next: async () => null }) }) }),
      };
    },
    client: { withSession: async (fn: any) => fn({ withTransaction: async (t: any) => t() }) },
  };
  return { db, writes };
}

const snapshot: EvidenceSnapshot = {
  transaction_id: 'txn-1', proposed_disposition: 'escalate', amount: 4950,
  risk_factors: ['structuring_amount'], compliance_score: 0.75,
};
const gateInput = {
  transaction_id: 'txn-1', evidence_hash: evidenceHash(snapshot),
  flag_reason: 'structuring_amount', snapshot,
};

/** Call the step's execute directly — no engine, no storage, no cluster. */
function runStep(db: any, over: Record<string, unknown> = {}) {
  const suspended: unknown[] = [];
  const params = {
    inputData: gateInput,
    resumeData: undefined,
    suspend: async (payload: unknown) => { suspended.push(payload); },
    requestContext: gateContext(db, 'secret'),
    ...over,
  };
  return { suspended, result: (reviewGateStep.execute as any)(params) };
}

describe('reviewGateStep (the durable pause itself)', () => {
  it('suspends on the first pass and commits NOTHING', async () => {
    const { db, writes } = fakeDb();
    const { suspended, result } = runStep(db);
    await result;
    // What the human needs in order to decide has to be IN the persisted suspend payload — the
    // resuming process may be a different process minutes or days later with no other context.
    expect(suspended).toHaveLength(1);
    expect(suspended[0]).toMatchObject({
      transaction_id: 'txn-1', evidence_hash: gateInput.evidence_hash, flag_reason: 'structuring_amount',
    });
    expect(writes['case_decisions']).toBeUndefined();
    expect(writes['audit_trail']).toBeUndefined();
  });

  it('commits through the real ledger path on resume when evidence still matches', async () => {
    const { db, writes } = fakeDb();
    const { suspended, result } = runStep(db, {
      resumeData: { decision: 'reject', current: snapshot, now: '2026-06-11T00:02:00Z' },
    });
    expect(await result).toEqual({ transaction_id: 'txn-1', status: 'committed' });
    expect(suspended).toHaveLength(0); // a resumed step must not pause again
    // reviewed_by 'human', and the audit link written in the same commit — i.e. it went through
    // commitCaseDecision, not around it.
    expect(writes['case_decisions']).toHaveLength(1);
    expect(writes['case_decisions'][0].doc.reviewed_by).toBe('human');
    expect(writes['case_decisions'][0].doc.decision).toBe('reject');
    expect(writes['audit_trail']).toHaveLength(1);
  });

  it('refuses a drifted snapshot: rejected_stale, and nothing committed', async () => {
    const { db, writes } = fakeDb();
    // The hash in inputData was captured at suspend-time; `current` is what the route re-derived now.
    const { result } = runStep(db, {
      resumeData: {
        decision: 'approve', now: '2026-06-11T00:02:00Z',
        current: { ...snapshot, compliance_score: 0.2 },
      },
    });
    expect(await result).toEqual({ transaction_id: 'txn-1', status: 'rejected_stale' });
    expect(writes['case_decisions']).toBeUndefined();
    expect(writes['audit_trail']).toBeUndefined();
  });

  it('uses the RE-DERIVED snapshot, not the one persisted at suspend-time', async () => {
    // Drift is only detectable if `current` wins over inputData.snapshot. If the step ever fell back
    // to its own suspend payload here, every stale case would commit and the check would be theatre —
    // so this asserts the precedence directly rather than trusting the test above.
    const { db, writes } = fakeDb();
    const drifted = { ...snapshot, amount: 9900 };
    const { result } = runStep(db, {
      resumeData: { decision: 'approve', current: drifted, now: '2026-06-11T00:02:00Z' },
    });
    expect((await result).status).toBe('rejected_stale');
    expect(writes['case_decisions']).toBeUndefined();
  });

  it('throws rather than reporting a phantom commit when the Db never reached the step', async () => {
    // requestContext is how the Db crosses into the step. Missing means the ledger cannot be written;
    // returning 'committed' anyway would be the one failure the audit chain exists to make impossible.
    const params = {
      inputData: gateInput,
      resumeData: { decision: 'approve' as const, current: snapshot, now: '2026-06-11T00:02:00Z' },
      suspend: async () => {},
      requestContext: undefined,
    };
    await expect((reviewGateStep.execute as any)(params)).rejects.toThrow(/requestContext/);
  });
});

describe('the workflow and its storage', () => {
  it('is a one-step workflow registered under a stable id', async () => {
    const wf: any = createReviewWorkflow();
    expect(wf.id).toBe(REVIEW_WORKFLOW_ID);
    expect(Object.keys(wf.steps)).toEqual([REVIEW_GATE_STEP_ID]);
  });

  it('owns exactly ONE collection, and the library agrees which', () => {
    // Guards the finding that a plain MongoDBStore creates 31 collections: the constant the reset
    // list clears must be the collection the engine actually manages, checked against the library's
    // own declaration rather than hardcoded twice.
    expect(WorkflowsStorageMongoDB.MANAGED_COLLECTIONS).toHaveLength(1);
    expect(WorkflowsStorageMongoDB.MANAGED_COLLECTIONS).toContain(WORKFLOW_SNAPSHOT_COLLECTION);
  });

  it('backs ONLY the workflows domain with MongoDB', () => {
    const m: any = createWorkflowMastra(fakeDb().db);
    const mongoBacked = Object.entries(m.getStorage().stores)
      .filter(([, s]) => /MongoDB/.test((s as any)?.constructor?.name ?? ''))
      .map(([k]) => k);
    // Anything else appearing here means a future change swapped in a full store and quietly
    // reintroduced ~30 empty framework collections onto the demo cluster.
    expect(mongoBacked).toEqual(['workflows']);
    // All three graphs are registered on the one instance and share the one snapshot store.
    expect(Object.keys(m.listWorkflows()).sort())
      .toEqual([CASE_WORKFLOW_ID, QUEUE_WORKFLOW_ID, REVIEW_WORKFLOW_ID].sort());
  });

  it('reaches no collection SYNCHRONOUSLY during construction', () => {
    // Narrow on purpose, and worth being precise about what it does not show. Construction returns
    // before anything is queried, which is what lets the server mount this on the request path. It is
    // NOT I/O-free: measured against Atlas, the engine creates `mastra_workflow_snapshot` on its own
    // ~107ms later. A unit test cannot pin that down without racing, so the read-only-user and
    // boot-time behaviour is verified on the box instead (see createWorkflowMastra's docstring).
    let touched = 0;
    createWorkflowMastra({ collection: () => { touched++; return {}; } } as any);
    expect(touched).toBe(0);
  });

  it('hands the app\'s own collections to the store and never closes its client', async () => {
    // The handler exists so the snapshot is read/written by the app's mongodb 6 driver — one pool, and
    // no bson 6/7 boundary. close() must be inert: the app owns that client.
    const closed: string[] = [];
    const db: any = { collection: (n: string) => ({ marker: n }), client: { close: () => closed.push('client') } };
    const handler = workflowConnectorHandler(db);
    expect(await handler.getCollection(WORKFLOW_SNAPSHOT_COLLECTION)).toEqual({ marker: WORKFLOW_SNAPSHOT_COLLECTION });
    await handler.close();
    expect(closed).toEqual([]);
  });
});

describe('start/resume are best-effort so the gate can never cost a held case', () => {
  const stubMastra = (workflow: unknown) => ({ getWorkflow: () => workflow }) as any;

  it('startReviewGate returns undefined when the run cannot be started', async () => {
    const m = stubMastra({ createRun: async () => { throw new Error('storage unreachable'); } });
    expect(await startReviewGate(m, fakeDb().db, 's', gateInput)).toBeUndefined();
  });

  it('startReviewGate returns the run id when the run suspends', async () => {
    const m = stubMastra({
      createRun: async () => ({ runId: 'run-7', start: async () => ({ status: 'suspended' }) }),
    });
    expect(await startReviewGate(m, fakeDb().db, 's', gateInput)).toBe('run-7');
  });

  it('resumeReviewGate returns undefined when the run cannot be resumed, so the route falls back', async () => {
    // A run already consumed by a racing caller throws here. The route must then commit directly —
    // it already holds the atomic claim, so falling back is correct, not a second commit.
    const m = stubMastra({
      createRun: async () => ({ resume: async () => { throw new Error('This workflow run was not suspended'); } }),
    });
    const out = await resumeReviewGate(m, fakeDb().db, 's', {
      runId: 'run-7', transaction_id: 'txn-1', decision: 'approve', current: snapshot, now: 'n',
    });
    expect(out).toBeUndefined();
  });

  it('resumeReviewGate surfaces the ledger status from the run result', async () => {
    for (const status of ['committed', 'rejected_stale'] as const) {
      const m = stubMastra({ createRun: async () => ({ resume: async () => ({ status: 'success', result: { status } }) }) });
      const out = await resumeReviewGate(m, fakeDb().db, 's', {
        runId: 'run-7', transaction_id: 'txn-1', decision: 'approve', current: snapshot, now: 'n',
      });
      expect(out).toBe(status);
    }
  });

  it('resumeReviewGate reports undefined for a run that neither committed nor refused', async () => {
    // A suspended-again or failed run has NOT decided the case. Mapping that to 'committed' would
    // answer the HTTP request with a decision the ledger never took.
    const m = stubMastra({ createRun: async () => ({ resume: async () => ({ status: 'suspended' }) }) });
    const out = await resumeReviewGate(m, fakeDb().db, 's', {
      runId: 'run-7', transaction_id: 'txn-1', decision: 'approve', current: snapshot, now: 'n',
    });
    expect(out).toBeUndefined();
  });
});

describe('runCaseInvestigation stays additive', () => {
  const facts = (o: Partial<TxnFacts> = {}): TxnFacts => ({ transaction_id: 'txn-1', amount: 4950, sender_account: 'A', ...o });
  const verdict = (o: Partial<AgentVerdict> = {}): AgentVerdict => ({ recommendation: 'approve', confidence: 96, risk_factors: [], rationale: 'clean', ...o });

  it('behaves exactly as before when no startGate is supplied', async () => {
    const { db, writes } = fakeDb();
    const out = await runCaseInvestigation(db, 's', facts(), verdict(), 0.75, false, '2026-06-11T00:00:00Z');
    expect(out.phase).toBe('suspended');
    expect(out.workflow_run_id).toBeUndefined();
    expect(writes['reviews']).toHaveLength(1); // the enqueue, and no run-id attach write
  });

  it('records the run id on the review, AFTER the authoritative enqueue', async () => {
    const { db, writes } = fakeDb();
    const seen: unknown[] = [];
    const out = await runCaseInvestigation(db, 's', facts(), verdict(), 0.75, false, '2026-06-11T00:00:00Z',
      async input => { seen.push(input); return 'run-7'; });
    expect(out.workflow_run_id).toBe('run-7');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ transaction_id: 'txn-1', evidence_hash: out.evidence_hash });
    // Order matters: enqueue first, then attach. Reversed, a failed run-start would point a suspended
    // run at a review that was never written.
    expect(writes['reviews'][0].update.$set.status).toBe('pending_review');
    expect(writes['reviews'][1].update.$set).toEqual({ workflow_run_id: 'run-7' });
  });

  it('holds the case anyway when the gate fails to start', async () => {
    const { db, writes } = fakeDb();
    const out = await runCaseInvestigation(db, 's', facts(), verdict(), 0.75, false, '2026-06-11T00:00:00Z',
      async () => undefined);
    expect(out.phase).toBe('suspended');
    expect(out.workflow_run_id).toBeUndefined();
    expect(writes['reviews']).toHaveLength(1); // enqueued, with nothing to point at
  });

  it('never opens a gate for a committed case', async () => {
    const { db } = fakeDb();
    let started = 0;
    const out = await runCaseInvestigation(db, 's', facts({ amount: 3200 }), verdict(), 1, false, '2026-06-11T00:00:00Z',
      async () => { started++; return 'run-7'; });
    expect(out.phase).toBe('committed');
    expect(started).toBe(0);
  });
});
