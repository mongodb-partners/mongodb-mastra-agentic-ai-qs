import type { Db } from 'mongodb';
import { AuditStore } from '../governance/audit-store';
import type { Disposition } from '../decision/core';

export const CASES_COLLECTION = 'cases';
export const DECISIONS_COLLECTION = 'case_decisions';
export const REVIEWS_COLLECTION = 'reviews';

export interface CommitInput {
  transaction_id: string;
  disposition: Disposition;
  confidence: number;
  risk_factors: string[];
  rationale: string;
  reviewed_by: 'agent' | 'human';
  compliance_score: number;
  now: string; // ISO
}

/**
 * Commit a decided case in ONE multi-document ACID transaction: flip the case status, insert the
 * immutable decision, and append a hash-chained audit event — all-or-nothing on one cluster.
 * Requires a transactional client (`db.client`).
 *
 * The audit append runs FULLY inside the transaction — `AuditStore.append` takes the session, so the
 * tail read and the insert are both session-scoped. That is what makes the chain safe under
 * concurrent commits: two transactions reading the same tail conflict on write and one aborts and
 * retries against the new tail, instead of both chaining to it and forking the chain.
 */
export async function commitCaseDecision(db: Db, auditSecret: string, input: CommitInput): Promise<void> {
  const client = (db as any).client;
  if (!client?.withSession) throw new Error('Case commit requires a transactional MongoDB client.');
  const audit = new AuditStore(db, auditSecret);
  const decisionId = `dec-${input.transaction_id}-${input.now}`;
  const finalStatus = input.disposition === 'approve' ? 'approved'
    : input.disposition === 'reject' ? 'rejected' : 'escalated';

  await client.withSession(async (session: any) => {
    await session.withTransaction(async () => {
      await db.collection(DECISIONS_COLLECTION).insertOne({
        _id: decisionId as any,
        transaction_id: input.transaction_id,
        decision: input.disposition,
        confidence_score: input.confidence,
        risk_factors: input.risk_factors,
        reasoning: { primary_reasoning: input.rationale },
        compliance_score: input.compliance_score,
        reviewed_by: input.reviewed_by,
        created_at: new Date(input.now),
      }, { session });

      await db.collection('transactions').updateOne(
        { transaction_id: input.transaction_id },
        { $set: { status: finalStatus } },
        { session },
      );

      await db.collection(CASES_COLLECTION).updateOne(
        { transaction_id: input.transaction_id },
        { $set: { transaction_id: input.transaction_id, state: 'CLEARED', disposition: input.disposition, decided_at: new Date(input.now) } },
        { upsert: true, session },
      );

      // Append the hash-chained audit event INSIDE the same transaction (review finding #3): the
      // decision and its audit link commit atomically — never one without the other. Shape-only
      // payload, never raw PII.
      await audit.append({
        event_type: 'decision_recorded',
        entity_id: input.transaction_id,
        actor: { type: input.reviewed_by, id: input.reviewed_by === 'human' ? 'analyst' : 'investigation-agent' },
        payload_summary: {
          fields: ['disposition', 'confidence_score', 'compliance_score', 'risk_factor_count'],
          disposition: input.disposition,
          risk_factor_count: input.risk_factors.length,
        },
        timestamp: new Date(input.now),
      }, session);
    });
  });
}

/** Enqueue a held/escalated case for human review. The full evidence snapshot is persisted so
 *  the resolve endpoint verifies against SERVER-stored state (never a client reconstruction). */
export async function enqueueReview(db: Db, input: {
  transaction_id: string; flag_reason: string; rules_triggered: string[];
  evidence_hash: string; snapshot: Record<string, unknown>; now: string;
}): Promise<void> {
  await db.collection(REVIEWS_COLLECTION).updateOne(
    { transaction_id: input.transaction_id },
    { $set: {
      transaction_id: input.transaction_id,
      flag_reason: input.flag_reason,
      rules_triggered: input.rules_triggered,
      evidence_hash: input.evidence_hash,
      snapshot: input.snapshot,
      status: 'pending_review',
      created_at: new Date(input.now),
    } },
    { upsert: true },
  );
  await db.collection(CASES_COLLECTION).updateOne(
    { transaction_id: input.transaction_id },
    { $set: { transaction_id: input.transaction_id, state: 'PENDING_REVIEW', evidence_hash: input.evidence_hash } },
    { upsert: true },
  );
}

/**
 * Record which suspended workflow run backs an already-enqueued review.
 *
 * A SEPARATE write, deliberately, and it must stay one. `enqueueReview` is the authoritative record
 * that a human owes this case a decision; the run id is an advisory pointer to the durable pause
 * wrapped around it. Folding it into `enqueueReview` would mean the review could not be written until
 * the workflow run existed, which inverts the dependency — the review has to exist first, because a
 * run that fails to start must cost the pause and not the case.
 *
 * `$set` on a matched document only: no upsert. If the review is gone (resolved by a concurrent
 * caller, or cleared by a reset) there is nothing to point at, and creating a stub review document
 * from a run id would invent a pending case no human asked for.
 */
export async function attachReviewRun(db: Db, transactionId: string, runId: string): Promise<void> {
  await db.collection(REVIEWS_COLLECTION).updateOne(
    { transaction_id: transactionId },
    { $set: { workflow_run_id: runId } },
  );
}
