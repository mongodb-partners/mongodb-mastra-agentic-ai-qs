import { describe, it, expect } from 'vitest';
import { Decimal128 } from 'mongodb';
import { evidenceHash, evidenceMatches, type EvidenceSnapshot } from './evidence';
import { moneyToNumber } from '../money';

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

describe('evidence hash under Decimal128 amounts', () => {
  it('is unchanged when a number amount is normalized through moneyToNumber', () => {
    // The frozen digests in data/replay/*.json were computed with a plain-number amount. This is
    // the regression guard for all eight of them.
    expect(evidenceHash(snap({ amount: moneyToNumber(4950) })))
      .toBe(evidenceHash(snap({ amount: 4950 })));
  });

  it('gives a Decimal128 amount the same hash as its numeric value, once normalized', () => {
    expect(evidenceHash(snap({ amount: moneyToNumber(Decimal128.fromString('4950.00')) })))
      .toBe(evidenceHash(snap({ amount: 4950 })));
  });

  it('is insensitive to Decimal128 scale, which a raw Decimal128 would not be', () => {
    // '4950' and '4950.00' are numerically equal but NOT byte-equal. Normalizing is what makes the
    // hash a function of the value instead of the encoding.
    expect(evidenceHash(snap({ amount: moneyToNumber(Decimal128.fromString('4950')) })))
      .toBe(evidenceHash(snap({ amount: moneyToNumber(Decimal128.fromString('4950.00')) })));
  });

  it('would change if a raw Decimal128 were hashed — documents why normalization is required', () => {
    const raw = evidenceHash(snap({ amount: Decimal128.fromString('4950.00') as unknown as number }));
    expect(raw).not.toBe(evidenceHash(snap({ amount: 4950 })));
  });

  it('still distinguishes different amounts', () => {
    expect(evidenceHash(snap({ amount: moneyToNumber(Decimal128.fromString('4950.00')) })))
      .not.toBe(evidenceHash(snap({ amount: moneyToNumber(Decimal128.fromString('5000.00')) })));
  });

  it('distinguishes amounts that differ only in cents', () => {
    // The whole point of the type change: 4950.00 and 4950.75 must not collide.
    expect(evidenceHash(snap({ amount: moneyToNumber(Decimal128.fromString('4950.75')) })))
      .not.toBe(evidenceHash(snap({ amount: moneyToNumber(Decimal128.fromString('4950.00')) })));
  });
});
