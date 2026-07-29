import { triage, reconcile, type TxnFacts, type AgentVerdict, type DecisionResult } from '../decision/core';
import { evidenceHash, evidenceMatches, type EvidenceSnapshot } from './evidence';
import { attachReviewRun, commitCaseDecision, enqueueReview } from './case-store';
import { moneyToNumber } from '../money';
import type { Db } from 'mongodb';

export interface InvestigationOutcome {
  transaction_id: string;
  decision: DecisionResult;
  compliance_score: number;
  /** 'committed' => auto-decided + persisted; 'suspended' => held for human review (durable gate). */
  phase: 'committed' | 'suspended';
  evidence_hash?: string;
  /**
   * The suspended workflow run backing this hold, when one was started.
   *
   * Absent is normal and must stay handleable: no `startGate` was supplied, the run failed to start
   * (best-effort by design — see startReviewGate), or the case was held before the durable gate
   * shipped. `reviews` is authoritative either way.
   */
  workflow_run_id?: string;
}

/**
 * Starts the durable review-gate run for a held case and returns its run id.
 *
 * Injected rather than imported so this module keeps taking its side effects as arguments — the same
 * reason the agent verdict is passed in. Every existing caller omits it and behaves exactly as
 * before, which is what makes the durable gate additive rather than a rewrite.
 */
export type StartGate = (input: {
  transaction_id: string; evidence_hash: string; flag_reason: string; snapshot: EvidenceSnapshot;
}) => Promise<string | undefined>;

/**
 * Run one case: deterministic triage → (agent verdict, provided by caller) reconcile →
 * governance score. If the reconciler says escalate OR governance holds, SUSPEND: enqueue a
 * review bound to an evidence hash (the durable human-in-the-loop gate) and stop. Otherwise
 * commit the auto-decision transactionally.
 *
 * The agent verdict + governance score are passed in (the caller runs the LLM agent + reviewer)
 * so this orchestration stays deterministic and unit-testable.
 */
export async function runCaseInvestigation(
  db: Db, auditSecret: string,
  facts: TxnFacts, verdict: AgentVerdict, complianceScore: number, held: boolean, now: string,
  startGate?: StartGate,
): Promise<InvestigationOutcome> {
  const hard = triage(facts);
  const decision = hard ?? reconcile(facts, verdict);
  // A hard-compliance decision (e.g. sanctions reject) is terminal — a governance `held` must NOT
  // suspend it into human review (review finding #1). Only non-hard decisions honor `held`.
  const mustSuspend = decision.must_escalate || (held && !hard);

  if (mustSuspend) {
    const snapshot: EvidenceSnapshot = {
      transaction_id: facts.transaction_id,
      proposed_disposition: decision.disposition,
      amount: moneyToNumber(facts.amount),
      risk_factors: decision.risk_factors,
      compliance_score: complianceScore,
    };
    const hash = evidenceHash(snapshot);
    const flag_reason = decision.risk_factors[0] ?? 'held_for_review';
    await enqueueReview(db, {
      transaction_id: facts.transaction_id,
      flag_reason,
      rules_triggered: decision.risk_factors,
      evidence_hash: hash,
      snapshot: snapshot as unknown as Record<string, unknown>,
      now,
    });
    // Start the durable gate AFTER the authoritative write, never before. `enqueueReview` is what
    // makes the case exist for a human; the workflow run is the advisory durable pause around it. In
    // this order a failure to start the run costs the pause and nothing else — reversing them would
    // open a window where a suspended run points at a review that was never enqueued.
    const workflow_run_id = await startGate?.({
      transaction_id: facts.transaction_id, evidence_hash: hash, flag_reason, snapshot,
    });
    if (workflow_run_id) await attachReviewRun(db, facts.transaction_id, workflow_run_id);
    return {
      transaction_id: facts.transaction_id, decision, compliance_score: complianceScore,
      phase: 'suspended', evidence_hash: hash,
      ...(workflow_run_id ? { workflow_run_id } : {}),
    };
  }

  await commitCaseDecision(db, auditSecret, {
    transaction_id: facts.transaction_id,
    disposition: decision.disposition,
    confidence: decision.confidence,
    risk_factors: decision.risk_factors,
    rationale: decision.rationale,
    reviewed_by: 'agent',
    compliance_score: complianceScore,
    now,
  });
  return { transaction_id: facts.transaction_id, decision, compliance_score: complianceScore, phase: 'committed' };
}

export interface ResumeResult { status: 'committed' | 'rejected_stale'; }

/**
 * Resume a suspended case with a human verdict — the fix for the broken-HITL failure mode. The
 * human echoes the evidence_hash they were shown; the server RE-DERIVES the hash from the CURRENT
 * snapshot and refuses to commit if it drifted (stale evidence). On match, commits the human
 * decision transactionally (reviewed_by: 'human').
 */
export async function resolveReview(
  db: Db, auditSecret: string,
  args: {
    transaction_id: string;
    human_decision: 'approve' | 'reject';
    echoed_evidence_hash: string;
    current: EvidenceSnapshot;
    confidence?: number;
    now: string;
  },
): Promise<ResumeResult> {
  if (!evidenceMatches(args.echoed_evidence_hash, args.current)) {
    return { status: 'rejected_stale' };
  }
  await commitCaseDecision(db, auditSecret, {
    transaction_id: args.transaction_id,
    disposition: args.human_decision,
    confidence: args.confidence ?? 100,
    risk_factors: args.current.risk_factors,
    rationale: `Human reviewer decided ${args.human_decision}.`,
    reviewed_by: 'human',
    compliance_score: args.current.compliance_score,
    now: args.now,
  });
  return { status: 'committed' };
}
