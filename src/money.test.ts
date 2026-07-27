import { describe, it, expect } from 'vitest';
import { Decimal128 } from 'mongodb';
import {
  MONEY_SCALE, toMoney, moneyToNumber, isMoney,
  compareMoney, moneyAtLeast, moneyAtMost, formatMoney,
} from './money';

describe('toMoney', () => {
  it('normalizes an integer to the money scale', () => {
    expect(toMoney(1256).toString()).toBe('1256.00');
  });

  it('normalizes a Decimal128 that already has a different scale', () => {
    // Decimal128 is NOT value-canonical: fromString('1256') and fromString('1256.00') are
    // numerically equal but have different bytes and different toString(). toMoney is what makes
    // two equal amounts produce one representation, which is what evidence hashing depends on.
    expect(toMoney(Decimal128.fromString('1256')).toString()).toBe('1256.00');
    expect(toMoney(Decimal128.fromString('1256.000')).toString()).toBe('1256.00');
    expect(toMoney(Decimal128.fromString('1256')).bytes)
      .toEqual(toMoney(Decimal128.fromString('1256.00')).bytes);
  });

  it('accepts a decimal string without going through a float', () => {
    expect(toMoney('1256.47').toString()).toBe('1256.47');
  });

  it('rounds half away from zero, matching ROUND_HALF_UP', () => {
    expect(toMoney('0.005').toString()).toBe('0.01');
    expect(toMoney('0.015').toString()).toBe('0.02');
    expect(toMoney('-0.005').toString()).toBe('-0.01');
  });

  it('does not inherit binary-float error from a fractional number', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in binary float. Going through the decimal STRING is what
    // the reference implementation's Decimal(str(value)) rule buys.
    expect(toMoney(0.1 + 0.2).toString()).toBe('0.30');
  });

  it('rejects a non-finite number rather than storing NaN', () => {
    expect(() => toMoney(Number.NaN)).toThrow(/finite/i);
    expect(() => toMoney(Number.POSITIVE_INFINITY)).toThrow(/finite/i);
  });

  it('rejects a string that is not a number', () => {
    expect(() => toMoney('twelve')).toThrow();
  });

  it('exposes the scale it normalizes to', () => {
    expect(MONEY_SCALE).toBe(2);
  });
});

describe('moneyToNumber', () => {
  it('round-trips a whole amount', () => {
    expect(moneyToNumber(toMoney(1256))).toBe(1256);
  });

  it('round-trips cents', () => {
    expect(moneyToNumber(toMoney('4950.75'))).toBe(4950.75);
  });

  it('passes a plain number through', () => {
    expect(moneyToNumber(4950)).toBe(4950);
  });
});

describe('isMoney', () => {
  it('is true for a Decimal128 and false for a number', () => {
    expect(isMoney(toMoney(1))).toBe(true);
    expect(isMoney(1)).toBe(false);
    expect(isMoney(null)).toBe(false);
    expect(isMoney({ $numberDecimal: '1.00' })).toBe(false);
  });
});

describe('compareMoney', () => {
  it('orders amounts numerically, not lexicographically', () => {
    // '1000.00' < '999.00' as strings. This is the trap the whole helper exists for.
    expect(compareMoney(toMoney(1000), toMoney(999))).toBe(1);
    expect(compareMoney(toMoney(999), toMoney(1000))).toBe(-1);
  });

  it('treats differently-scaled equal values as equal', () => {
    expect(compareMoney(Decimal128.fromString('1256'), Decimal128.fromString('1256.00'))).toBe(0);
  });

  it('compares across types', () => {
    expect(compareMoney(toMoney(4950), 4950)).toBe(0);
    expect(compareMoney(toMoney('4950.01'), 4950)).toBe(1);
  });

  it('handles negatives', () => {
    expect(compareMoney(toMoney(-5), toMoney(5))).toBe(-1);
  });
});

describe('moneyAtLeast / moneyAtMost', () => {
  it('is inclusive at the bound', () => {
    // The structuring band is [4900, 4999]; both ends must be inside it.
    expect(moneyAtLeast(toMoney(4900), 4900)).toBe(true);
    expect(moneyAtMost(toMoney(4999), 4999)).toBe(true);
  });

  it('excludes just outside the bound', () => {
    expect(moneyAtLeast(toMoney('4899.99'), 4900)).toBe(false);
    expect(moneyAtMost(toMoney('4999.01'), 4999)).toBe(false);
  });

  it('does not depend on implicit stringification the way a bare operator does', () => {
    // A bare `d >= 4900` happens to give the right answer for ordinary magnitudes: the relational
    // operator calls toString(), and a string-vs-number comparison then coerces numerically.
    // Measured 2026-07-27 across 50000.00 / 1256.00 / 4900.00 / 4899.99 / 0.00 / -5.00 / 1e30 —
    // all nine agreed with the numeric answer. So this is NOT a silent-failure trap, and the
    // helper is not load-bearing for correctness at these magnitudes.
    const d = toMoney(50000);
    expect((d as unknown as number) >= 4900).toBe(true);
    expect(moneyAtLeast(d, 4900)).toBe(true);

    // What IS broken is equality: `===` is reference equality, so two Decimal128s holding the same
    // value are never equal, and `toMoney` normalizing the scale does not save you.
    expect(toMoney(1256) === toMoney(1256)).toBe(false);
    expect(compareMoney(toMoney(1256), toMoney(1256))).toBe(0);
  });
});

describe('formatMoney', () => {
  it('groups thousands and keeps the scale', () => {
    expect(formatMoney(toMoney(1256))).toBe('1,256.00');
    expect(formatMoney(toMoney(120000))).toBe('120,000.00');
  });

  it('formats cents', () => {
    expect(formatMoney(toMoney('4950.75'))).toBe('4,950.75');
  });

  it('accepts a plain number', () => {
    expect(formatMoney(1256)).toBe('1,256.00');
  });
});
