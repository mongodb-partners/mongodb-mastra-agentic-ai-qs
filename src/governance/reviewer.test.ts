import { describe, it, expect } from 'vitest';
import { reviewAction, retrieveRelevantPolicies, type PolicyJudge } from './reviewer';
import { POLICIES_INDEX } from '../retrieval/vector-store';

/**
 * Fake `MongoDBVector` returning DOCUMENT-MODE policy results and recording the query params.
 *
 * The nesting is the point. In `metadataMode: 'document'` the library projects `metadata: '$$ROOT'`,
 * so a hit is `{id, score, metadata: <the policy document>}` — the policy fields are never at the
 * top level. See the mapping test below for why a flat fake would be worse than no test.
 */
function fakeStore(policies: any[]) {
  const calls: any[] = [];
  return {
    calls,
    store: {
      async query(params: any) {
        calls.push(params);
        return policies.map((p, i) => ({ id: `p-${i}`, score: 0.9 - i * 0.1, metadata: p }));
      },
    } as any,
  };
}
const embed = async () => Array.from({ length: 1024 }, () => 0.03);

describe('retrieveRelevantPolicies', () => {
  const policyDoc = {
    _id: 'bson-object-id',
    policy_code: 'AML-STRUCT-001',
    policy_text: 'Structuring is prohibited.',
    severity: 'high',
    category: 'aml',
    is_current_version: true,
    version: 3,
  };

  it('reads the fields off metadata, not off the top level', async () => {
    // THE HIGHEST-VALUE TEST IN THIS FILE, because the failure is silent and looks like good news.
    // Reading `h.policy_code` instead of `h.metadata.policy_code` yields `undefined` for every
    // policy with nothing thrown. `evaluateGovernance` then compares the judge's citations against a
    // retrieved set of `[undefined, undefined]`, its hallucination filter drops all of them, and the
    // case reports zero violations with a compliance score of 1.0 — indistinguishable from a
    // genuinely clean review, and sealed into the audit record as an attestation that policy was
    // checked and passed. Same absence-of-evidence shape as a fabricated fund trace.
    const { store } = fakeStore([policyDoc]);
    const [p] = await retrieveRelevantPolicies(store, embed, 'approve a $4,950 deposit');
    expect(p).toEqual({
      policy_code: 'AML-STRUCT-001',
      policy_text: 'Structuring is prohibited.',
      severity: 'high',
      category: 'aml',
    });
  });

  it("asks for 'document' mode against the policies index", async () => {
    // 'field' (the default) projects `metadata: '$metadata'`, and these are the app's own BYO policy
    // documents — nothing wrote a managed `metadata` subdocument for them to find.
    const { store, calls } = fakeStore([policyDoc]);
    await retrieveRelevantPolicies(store, embed, 'x');
    expect(calls[0].metadataMode).toBe('document');
    expect(calls[0].indexName).toBe(POLICIES_INDEX);
  });

  it('excludes superseded revisions in the search itself', async () => {
    // `is_current_version` is a declared filter path in the app's index definition, so this is
    // pushed into `$vectorSearch.filter` rather than applied after the fact.
    const { store, calls } = fakeStore([policyDoc]);
    await retrieveRelevantPolicies(store, embed, 'x');
    expect(calls[0].filter).toEqual({ is_current_version: true });
  });

  it('passes numCandidates explicitly rather than inheriting topK * 20', async () => {
    const { store, calls } = fakeStore([policyDoc]);
    await retrieveRelevantPolicies(store, embed, 'x', 5);
    expect(calls[0].topK).toBe(5);
    expect(calls[0].numCandidates).toBe(50);
  });
});

describe('reviewAction', () => {
  const retrieved = [
    { policy_code: 'AML-STRUCT-001', policy_text: '...', severity: 'high', category: 'aml' },
    { policy_code: 'SANC-SCREEN-001', policy_text: '...', severity: 'critical', category: 'sanctions' },
  ];
  const store = () => fakeStore(retrieved).store;

  it('uses the AUTHORITATIVE stored severity, not the LLM-reported one (finding #4)', async () => {
    // Judge misreports a critical policy as "low"; scoring must still use the stored critical.
    const judge: PolicyJudge = async () => ({
      violations: [{ policy_code: 'SANC-SCREEN-001', severity: 'low', cited_text: 'sanctions' }],
    });
    const r = await reviewAction(store(), embed, judge, 'approve a sanctioned wire');
    // critical penalty 0.4 -> score 0.6 (NOT low's 0.05 -> 0.95).
    expect(r.compliance_score).toBeCloseTo(0.6, 4);
    expect(r.violations[0].severity).toBe('critical');
  });

  it('holds when the judge cites a retrieved high+critical pair', async () => {
    const judge: PolicyJudge = async () => ({
      violations: [
        { policy_code: 'AML-STRUCT-001', severity: 'high', cited_text: 'structuring' },
        { policy_code: 'SANC-SCREEN-001', severity: 'critical', cited_text: 'sanctions' },
      ],
    });
    const r = await reviewAction(store(), embed, judge, 'auto-approve a $4,950 deposit');
    expect(r.held).toBe(true);
    expect(r.compliance_score).toBeCloseTo(0.35, 4);
    expect(r.retrieved).toHaveLength(2);
  });

  it('drops a hallucinated policy code so it cannot force a hold', async () => {
    const judge: PolicyJudge = async () => ({
      violations: [{ policy_code: 'NOT-REAL-001', severity: 'critical', cited_text: 'made up' }],
    });
    const r = await reviewAction(store(), embed, judge, 'approve a clean payroll credit');
    expect(r.violations).toHaveLength(0);
    expect(r.dropped_citations).toEqual(['NOT-REAL-001']);
    expect(r.held).toBe(false);
  });

  it('passes a clean action with no violations', async () => {
    const judge: PolicyJudge = async () => ({ violations: [] });
    const r = await reviewAction(store(), embed, judge, 'approve a $30 coffee purchase');
    expect(r.compliance_score).toBe(1);
    expect(r.held).toBe(false);
  });

  it('fails CLOSED when the judge is unavailable — holds instead of scoring clean', async () => {
    // A judge that exhausted its retries knows nothing about this action. The dangerous outcome is
    // treating that silence as compliance: score 1.0, held false, auto-commit, and an audit entry
    // attesting to a review that never happened.
    const judge: PolicyJudge = async () => { throw new Error('no valid verdict after 3 attempts'); };
    const r = await reviewAction(store(), embed, judge, 'approve a sanctioned wire');
    expect(r.held).toBe(true);
    expect(r.compliance_score).toBe(0);
    expect(r.judge_unavailable).toBe(true);
    // Still reports what was retrieved, so the held case shows the policies a human should weigh.
    expect(r.retrieved).toHaveLength(2);
  });

  it('does not propagate the judge failure — the case must still reach the audit write', async () => {
    // Rethrowing would abort the case in run-engine's per-case try/catch BEFORE governance is
    // persisted, the audit event is appended and the review gate runs.
    const judge: PolicyJudge = async () => { throw new Error('boom'); };
    await expect(reviewAction(store(), embed, judge, 'x')).resolves.toBeDefined();
  });
});
