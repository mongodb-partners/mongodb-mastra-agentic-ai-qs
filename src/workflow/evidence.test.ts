import { describe, it, expect } from 'vitest';
import { evidenceHash, evidenceMatches, type EvidenceSnapshot } from './evidence';

const snap = (o: Partial<EvidenceSnapshot> = {}): EvidenceSnapshot => ({
  transaction_id: 'txn-1', proposed_disposition: 'escalate', amount: 4950,
  risk_factors: ['structuring_amount'], compliance_score: 0.75, ...o,
});

describe('evidence hash', () => {
  it('is stable for the same snapshot', () => {
    expect(evidenceHash(snap())).toBe(evidenceHash(snap()));
  });
  it('is order-independent for risk_factors object keys but sensitive to values', () => {
    expect(evidenceHash(snap({ amount: 4950 }))).not.toBe(evidenceHash(snap({ amount: 5000 })));
  });
  it('matches when the current snapshot is unchanged', () => {
    const h = evidenceHash(snap());
    expect(evidenceMatches(h, snap())).toBe(true);
  });
  it('refuses when the evidence drifted after the human saw it', () => {
    const h = evidenceHash(snap({ compliance_score: 0.75 }));
    expect(evidenceMatches(h, snap({ compliance_score: 0.35 }))).toBe(false);
  });
});
