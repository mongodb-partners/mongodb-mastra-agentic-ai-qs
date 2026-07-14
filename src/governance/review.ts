import { SEVERITY_PENALTY, COMPLIANCE_THRESHOLD, type Severity } from './policies';

export interface Violation {
  policy_code: string;
  severity: Severity;
  cited_text: string;
}

export interface GovernanceResult {
  compliance_score: number;
  violations: Violation[];
  dropped_citations: string[]; // policy_codes the reviewer cited that were NOT retrieved
  held: boolean;               // true => below threshold, route to human review
}

/**
 * Drop any violation whose policy_code is not in the set of ACTUALLY-RETRIEVED policies. This is
 * the anti-hallucination guardrail: the reviewer may only cite policies that were surfaced to it.
 * Returns the kept violations plus the dropped policy_codes (for the audit trail).
 */
export function filterHallucinatedViolations(
  violations: Violation[], retrievedCodes: string[],
): { kept: Violation[]; dropped: string[] } {
  const allowed = new Set(retrievedCodes);
  const kept: Violation[] = [];
  const dropped: string[] = [];
  for (const v of violations) {
    if (allowed.has(v.policy_code)) kept.push(v);
    else dropped.push(v.policy_code);
  }
  return { kept, dropped };
}

/** Deterministic compliance score: 1.0 minus the summed severity penalties, floored at 0. */
export function computeComplianceScore(violations: Violation[]): number {
  const penalty = violations.reduce((sum, v) => sum + (SEVERITY_PENALTY[v.severity] ?? 0), 0);
  return Math.max(0, Number((1 - penalty).toFixed(4)));
}

/** Combine the filter + score + threshold into the governance verdict. */
export function evaluateGovernance(
  violations: Violation[], retrievedCodes: string[],
): GovernanceResult {
  const { kept, dropped } = filterHallucinatedViolations(violations, retrievedCodes);
  const score = computeComplianceScore(kept);
  return {
    compliance_score: score,
    violations: kept,
    dropped_citations: dropped,
    held: score < COMPLIANCE_THRESHOLD,
  };
}
