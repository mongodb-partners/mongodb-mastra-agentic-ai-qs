import { describe, it, expect } from 'vitest';
import { reviewAction, type PolicyJudge } from './reviewer';

// Fake Db whose policy $vectorSearch returns a fixed retrieved set.
function fakeDb(retrieved: any[]) {
  return {
    collection() {
      return { aggregate() { return { toArray: async () => retrieved }; } };
    },
  };
}
const embed = async () => Array.from({ length: 1024 }, () => 0.03);

describe('reviewAction', () => {
  const retrieved = [
    { policy_code: 'AML-STRUCT-001', policy_text: '...', severity: 'high', category: 'aml' },
    { policy_code: 'SANC-SCREEN-001', policy_text: '...', severity: 'critical', category: 'sanctions' },
  ];

  it('uses the AUTHORITATIVE stored severity, not the LLM-reported one (finding #4)', async () => {
    // Judge misreports a critical policy as "low"; scoring must still use the stored critical.
    const judge: PolicyJudge = async () => ({
      violations: [{ policy_code: 'SANC-SCREEN-001', severity: 'low', cited_text: 'sanctions' }],
    });
    const r = await reviewAction(fakeDb(retrieved) as any, embed, judge, 'approve a sanctioned wire');
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
    const r = await reviewAction(fakeDb(retrieved) as any, embed, judge, 'auto-approve a $4,950 deposit');
    expect(r.held).toBe(true);
    expect(r.compliance_score).toBeCloseTo(0.35, 4);
    expect(r.retrieved).toHaveLength(2);
  });

  it('drops a hallucinated policy code so it cannot force a hold', async () => {
    const judge: PolicyJudge = async () => ({
      violations: [{ policy_code: 'NOT-REAL-001', severity: 'critical', cited_text: 'made up' }],
    });
    const r = await reviewAction(fakeDb(retrieved) as any, embed, judge, 'approve a clean payroll credit');
    expect(r.violations).toHaveLength(0);
    expect(r.dropped_citations).toEqual(['NOT-REAL-001']);
    expect(r.held).toBe(false);
  });

  it('passes a clean action with no violations', async () => {
    const judge: PolicyJudge = async () => ({ violations: [] });
    const r = await reviewAction(fakeDb(retrieved) as any, embed, judge, 'approve a $30 coffee purchase');
    expect(r.compliance_score).toBe(1);
    expect(r.held).toBe(false);
  });
});
