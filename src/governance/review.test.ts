import { describe, it, expect } from 'vitest';
import {
  filterHallucinatedViolations, computeComplianceScore, evaluateGovernance, type Violation,
} from './review';

const v = (code: string, severity: any): Violation => ({ policy_code: code, severity, cited_text: 't' });

describe('filterHallucinatedViolations', () => {
  it('drops citations of policies that were not retrieved', () => {
    const { kept, dropped } = filterHallucinatedViolations(
      [v('AML-STRUCT-001', 'high'), v('FAKE-999-001', 'critical')],
      ['AML-STRUCT-001', 'SANC-SCREEN-001'],
    );
    expect(kept.map(k => k.policy_code)).toEqual(['AML-STRUCT-001']);
    expect(dropped).toEqual(['FAKE-999-001']);
  });
});

describe('computeComplianceScore', () => {
  it('is 1.0 with no violations', () => {
    expect(computeComplianceScore([])).toBe(1);
  });
  it('subtracts severity penalties', () => {
    expect(computeComplianceScore([v('X', 'high')])).toBeCloseTo(0.75, 4);   // 1 - 0.25
    expect(computeComplianceScore([v('X', 'critical')])).toBeCloseTo(0.6, 4); // 1 - 0.4
  });
  it('floors at 0', () => {
    expect(computeComplianceScore([v('a', 'critical'), v('b', 'critical'), v('c', 'critical')])).toBe(0);
  });
});

describe('evaluateGovernance', () => {
  it('holds when a hallucination-filtered score falls below threshold', () => {
    const r = evaluateGovernance([v('AML-STRUCT-001', 'high'), v('SANC-SCREEN-001', 'critical')], ['AML-STRUCT-001', 'SANC-SCREEN-001']);
    expect(r.compliance_score).toBeCloseTo(0.35, 4); // 1 - 0.25 - 0.4
    expect(r.held).toBe(true);
    expect(r.dropped_citations).toEqual([]);
  });
  it('does not hold a clean action', () => {
    const r = evaluateGovernance([], ['AML-STRUCT-001']);
    expect(r.compliance_score).toBe(1);
    expect(r.held).toBe(false);
  });
  it('ignores a hallucinated critical citation (not retrieved) so it cannot force a hold', () => {
    const r = evaluateGovernance([v('FAKE-999-001', 'critical')], ['AML-STRUCT-001']);
    expect(r.violations).toHaveLength(0);
    expect(r.dropped_citations).toEqual(['FAKE-999-001']);
    expect(r.held).toBe(false);
  });
});
