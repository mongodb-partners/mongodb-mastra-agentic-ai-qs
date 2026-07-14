import { createHash } from 'node:crypto';
import { canonicalize } from '../governance/audit-chain';

/** The snapshot the human approves, bound into the evidence hash. */
export interface EvidenceSnapshot {
  transaction_id: string;
  proposed_disposition: 'approve' | 'reject' | 'escalate';
  amount: number;
  risk_factors: string[];
  compliance_score: number;
}

/**
 * evidence_hash = sha256(canonicalize(snapshot)). Binds a human approval to the EXACT evidence +
 * proposed action it was shown. On resume the server re-derives the hash from current state and
 * refuses if it drifted (stale evidence) — the fix for the "approve resumes a different run /
 * stale state" failure mode.
 */
export function evidenceHash(snapshot: EvidenceSnapshot): string {
  return createHash('sha256').update(canonicalize(snapshot)).digest('hex');
}

/** True when the hash the human echoes back matches the hash re-derived from current evidence. */
export function evidenceMatches(expected: string, current: EvidenceSnapshot): boolean {
  return evidenceHash(current) === expected;
}
