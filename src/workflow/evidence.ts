import { createHash } from 'node:crypto';
import { canonicalize } from '../governance/audit-chain';

/** The snapshot the human approves, bound into the evidence hash. */
export interface EvidenceSnapshot {
  transaction_id: string;
  proposed_disposition: 'approve' | 'reject' | 'escalate';
  /**
   * A plain number, DELIBERATELY, even though `transactions.amount` is a Decimal128.
   *
   * `evidenceHash` canonicalizes this object, and `canonicalize` walks own enumerable properties —
   * a Decimal128's only own property is `bytes`, so hashing one directly would make the digest a
   * function of the BYTE ENCODING. Decimal128 is not value-canonical: `4950` and `4950.00` are
   * numerically equal with different bytes, so the same amount could produce two different
   * evidence hashes and `/api/reviews/:id/resolve` would refuse a valid approval as stale.
   *
   * Callers normalize with `moneyToNumber` when building a snapshot. This also keeps the frozen
   * digests in data/replay/*.json valid (verified: normalizing reproduces them exactly).
   */
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
