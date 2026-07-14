import type { Db } from 'mongodb';
import { z } from 'zod';
import { POLICIES_COLLECTION, POLICY_VECTOR_INDEX, type Severity } from './policies';
import { evaluateGovernance, type GovernanceResult, type Violation } from './review';

export type EmbedQuery = (text: string) => Promise<number[]>;

export interface RetrievedPolicy { policy_code: string; policy_text: string; severity: Severity; category: string; }

/** The structured verdict the policy-reviewer LLM must return. */
export const ReviewerOutputSchema = z.object({
  violations: z.array(z.object({
    policy_code: z.string(),
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    cited_text: z.string(),
  })),
});
export type ReviewerOutput = z.infer<typeof ReviewerOutputSchema>;

/** The LLM judge: given the action + retrieved policies, returns cited violations. Injected so
 *  the reviewer is testable without a live model. */
export type PolicyJudge = (args: { action: string; policies: RetrievedPolicy[] }) => Promise<ReviewerOutput>;

/** Retrieve the policies most relevant to an action via $vectorSearch (current versions only). */
export async function retrieveRelevantPolicies(
  db: Db, embedQuery: EmbedQuery, action: string, limit = 5,
): Promise<RetrievedPolicy[]> {
  const qvec = await embedQuery(action);
  return db.collection(POLICIES_COLLECTION).aggregate<RetrievedPolicy>([
    {
      $vectorSearch: {
        index: POLICY_VECTOR_INDEX, path: 'embedding', queryVector: qvec,
        numCandidates: Math.max(50, limit * 10), limit,
        filter: { is_current_version: true },
      },
    },
    { $project: { _id: 0, policy_code: 1, policy_text: 1, severity: 1, category: 1 } },
  ]).toArray();
}

/**
 * Review an agent action against policy: retrieve the relevant policies, ask the judge to cite
 * violations, then deterministically filter hallucinated citations + score + decide hold. The
 * governance verdict is grounded (only retrieved policies count) and reproducible (severity math).
 */
export async function reviewAction(
  db: Db, embedQuery: EmbedQuery, judge: PolicyJudge, action: string,
): Promise<GovernanceResult & { retrieved: RetrievedPolicy[] }> {
  const policies = await retrieveRelevantPolicies(db, embedQuery, action);
  const out = await judge({ action, policies });
  // Use the AUTHORITATIVE stored severity from the retrieved policy, not the LLM-reported one
  // (review finding #4): the judge only identifies WHICH policy is violated; the penalty weight
  // comes from the policy record, so a model misclassifying a critical rule as "low" can't
  // under-penalize. Unknown codes are dropped by evaluateGovernance's hallucination filter.
  const sevByCode = new Map(policies.map(p => [p.policy_code, p.severity]));
  const violations: Violation[] = out.violations.map(v => ({
    policy_code: v.policy_code,
    severity: sevByCode.get(v.policy_code) ?? v.severity,
    cited_text: v.cited_text,
  }));
  const result = evaluateGovernance(violations, policies.map(p => p.policy_code));
  return { ...result, retrieved: policies };
}
