import type { MongoDBVector } from '@mastra/mongodb';
import { z } from 'zod';
import type { Severity } from './policies';
import { POLICIES_INDEX } from '../retrieval/vector-store';
import { evaluateGovernance, type GovernanceResult, type Violation } from './review';
import { logger } from '../observability/logger';

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

/**
 * Retrieve the policies most relevant to an action via $vectorSearch (current versions only).
 *
 * Runs through `@mastra/mongodb`'s `MongoDBVector` against the read-only BYO `policies` index.
 *
 * `metadataMode: 'document'` is what makes this work at all, and its failure mode is why the
 * document-mode mapping below is spelled out field by field rather than spread. These are the app's
 * own operational policy documents, not vectors the store upserted, so there is no managed
 * `metadata` subdocument for the default `'field'` mode to project — in that mode every result comes
 * back with `metadata: undefined`, so every `policy_code` is `undefined`. Nothing throws. Instead
 * `evaluateGovernance`'s hallucination filter, which keeps only codes present in the retrieved set,
 * drops every citation the judge makes: the case reports zero violations and a compliance score of
 * 1.0, indistinguishable from a genuinely clean review. That is the same
 * absence-of-evidence-as-evidence-of-absence shape as a fabricated fund trace, and it would reach
 * the hash-sealed audit record as an attestation that policy was checked and passed.
 *
 * No `$project` equivalent is needed: `severity` and `policy_code` come off the source document, and
 * the library already `$unset`s the embedding in document mode.
 */
export async function retrieveRelevantPolicies(
  store: MongoDBVector, embedQuery: EmbedQuery, action: string, limit = 5,
): Promise<RetrievedPolicy[]> {
  const queryVector = await embedQuery(action);
  const hits = await store.query({
    indexName: POLICIES_INDEX,
    queryVector,
    topK: limit,
    // Explicit, preserving the previous `Math.max(50, limit * 10)`. Five short policy documents put
    // this nowhere near the 1M-corpus tail that VECTOR_CANDIDATE_FLOOR exists for, but the library's
    // `topK * 20` default would still silently redefine it, so it is stated rather than inherited.
    numCandidates: Math.max(50, limit * 10),
    metadataMode: 'document',
    // Pushed into `$vectorSearch.filter`: `is_current_version` is a declared filter path in the
    // app's own index definition (provision-policies.ts), so superseded revisions are excluded by
    // the search itself rather than after the fact.
    filter: { is_current_version: true },
  });
  return hits.map(h => {
    const m = (h.metadata ?? {}) as Record<string, any>;
    return {
      policy_code: m.policy_code,
      policy_text: m.policy_text,
      severity: m.severity as Severity,
      category: m.category,
    };
  });
}

/**
 * Review an agent action against policy: retrieve the relevant policies, ask the judge to cite
 * violations, then deterministically filter hallucinated citations + score + decide hold. The
 * governance verdict is grounded (only retrieved policies count) and reproducible (severity math).
 */
export async function reviewAction(
  store: MongoDBVector, embedQuery: EmbedQuery, judge: PolicyJudge, action: string,
): Promise<GovernanceResult & { retrieved: RetrievedPolicy[]; judge_unavailable?: true }> {
  const policies = await retrieveRelevantPolicies(store, embedQuery, action);
  let out: ReviewerOutput;
  try {
    out = await judge({ action, policies });
  } catch (err) {
    // FAIL CLOSED. The judge exhausted its retries (see judgeWithRetry), so we do not know whether
    // this action violates policy — and "unknown" must never be scored as "compliant". Hold the case
    // for a human with a zero compliance score instead of letting the absence of a verdict read as a
    // clean one. Deliberately NOT a rethrow: propagating here would abort the case before governance
    // is persisted, the audit event is appended and the human-review gate runs, which is the same
    // reasoning that makes an over-wide $graphLookup return an empty chain rather than throw.
    logger.error('policy judge unavailable; holding the case for human review', {
      action: action.slice(0, 120), err: String(err),
    });
    return {
      compliance_score: 0,
      violations: [],
      dropped_citations: [],
      held: true,
      retrieved: policies,
      judge_unavailable: true,
    };
  }
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
