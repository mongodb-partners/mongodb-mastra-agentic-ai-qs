import { Decimal128 } from 'mongodb';

/**
 * Money handling for Marshal. The ONLY module that knows `amount` is a BSON Decimal128.
 *
 * Ported from the pattern in maap-temporal-ai-agent-qs/utils/decimal_utils.py: convert through the
 * decimal STRING (never a binary float), normalize to a fixed scale, and compare through a helper
 * instead of an operator. Python's `decimal.Decimal` has no JS equivalent, so Decimal128 is both
 * the storage type and the working type here and the Decimal middle layer collapses away.
 *
 * Why these helpers exist — three things about Decimal128 in JS fail SILENTLY:
 *
 *   1. `z.number().safeParse(d).success` is `false`, so a Zod money field must be a union.
 *   2. `JSON.stringify(d)` emits `{"$numberDecimal":"1256.00"}` — an object, not a number. Any
 *      client doing arithmetic on the parsed value gets NaN.
 *   3. Decimal128 is NOT value-canonical: `fromString('1256')` and `fromString('1256.00')` are
 *      numerically equal but have DIFFERENT bytes (`e804…4030` vs `a0ea…3c30`) and different
 *      `toString()` (`'1256'` vs `'1256.00'`). Anything that hashes, key-matches, or byte-compares
 *      an amount must call `toMoney` first. This is the one that motivates fixing the scale.
 *
 * And one that does NOT fail, corrected after measuring: **a bare `d >= 4900` gives the right
 * answer.** The relational operator calls `toString()`, and a string-vs-number comparison coerces
 * numerically — verified across 50000.00 / 1256.00 / 4900.00 / 4899.99 / 0.00 / -5.00 / 1e30, all
 * agreeing with the numeric result. So `compareMoney`/`moneyAtLeast`/`moneyAtMost` are here for
 * readability and for accepting mixed `MoneyLike` inputs, NOT to rescue a broken operator; a bare
 * comparison at these magnitudes is not a latent bug. What genuinely breaks is **equality**:
 * `===` is reference equality, so two Decimal128s holding the same value are never `===`.
 *
 * Measured on the Node driver 2026-07-27.
 */

/** Decimal places every stored amount is normalized to. Two, because these are currency values. */
export const MONEY_SCALE = 2;

/** Anything this module will accept as money. A Decimal128 from the DB, a literal, or a string. */
export type MoneyLike = Decimal128 | number | string;

export function isMoney(value: unknown): value is Decimal128 {
  return value instanceof Decimal128;
}

/**
 * Normalize any money-ish value to a Decimal128 with exactly MONEY_SCALE decimal places, rounding
 * half away from zero (ROUND_HALF_UP, matching the reference implementation).
 *
 * Fixing the scale is what makes two numerically-equal amounts produce one representation, which
 * `evidenceHash` and any byte comparison depend on (trap 3 above).
 *
 * Conversion goes through the decimal string in every branch. `toFixed` on a Number is exact for
 * the magnitudes money takes (well inside 2^53) and is how the binary-float error in a value like
 * `0.1 + 0.2` gets dropped rather than carried into storage.
 */
export function toMoney(value: MoneyLike): Decimal128 {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`amount must be a finite number, got ${value}`);
    }
    return Decimal128.fromString(value.toFixed(MONEY_SCALE));
  }
  const text = isMoney(value) ? value.toString() : value.trim();
  // Decimal128.fromString accepts 'NaN' and 'Infinity'; neither is a currency value.
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(text)) {
    throw new TypeError(`amount is not a decimal number: ${JSON.stringify(String(value))}`);
  }
  return Decimal128.fromString(scaleDecimalString(text, MONEY_SCALE));
}

/**
 * Rescale a decimal string to `places`, rounding half away from zero — done on the digits rather
 * than by going through a float, so a 34-digit Decimal128 does not lose precision on the way.
 */
function scaleDecimalString(text: string, places: number): string {
  const negative = text.startsWith('-');
  const unsigned = text.replace(/^[+-]/, '');
  const [whole, fraction = ''] = unsigned.split('.');
  const sign = negative ? '-' : '';

  if (fraction.length <= places) {
    return `${sign}${whole || '0'}.${fraction.padEnd(places, '0')}`;
  }
  // Truncate to `places`, then round up when the first dropped digit is >= 5 (half away from zero).
  const kept = fraction.slice(0, places);
  const roundUp = Number(fraction[places]) >= 5;
  if (!roundUp) return `${sign}${whole || '0'}.${kept}`;

  // Increment the kept digits as one integer so a carry propagates into the whole part.
  const digits = `${whole || '0'}${kept}`;
  const bumped = (BigInt(digits) + 1n).toString().padStart(digits.length, '0');
  const cut = bumped.length - places;
  return `${sign}${bumped.slice(0, cut) || '0'}.${bumped.slice(cut)}`;
}

/**
 * Money as a JS number, for display, arithmetic on the client, and JSON payloads.
 *
 * Lossy in principle — the reference implementation documents its `decimal_to_float` the same way.
 * Sound in practice for the range Marshal handles: every amount is well inside 2^53 with two
 * decimal places. Do not use it to accumulate a running total over many rows.
 */
export function moneyToNumber(value: MoneyLike): number {
  const n = typeof value === 'number' ? value : Number(isMoney(value) ? value.toString() : value);
  if (!Number.isFinite(n)) throw new TypeError(`amount is not a finite number: ${String(value)}`);
  return n;
}

/** Numeric three-way comparison, accepting any MoneyLike on either side. */
export function compareMoney(a: MoneyLike, b: MoneyLike): -1 | 0 | 1 {
  const x = moneyToNumber(a);
  const y = moneyToNumber(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** `value >= bound`, done safely. */
export function moneyAtLeast(value: MoneyLike, bound: MoneyLike): boolean {
  return compareMoney(value, bound) >= 0;
}

/** `value <= bound`, done safely. */
export function moneyAtMost(value: MoneyLike, bound: MoneyLike): boolean {
  return compareMoney(value, bound) <= 0;
}

/** Grouped display string at the money scale, e.g. `1,256.00`. No currency symbol. */
export function formatMoney(value: MoneyLike): string {
  return moneyToNumber(toMoney(value)).toLocaleString('en-US', {
    minimumFractionDigits: MONEY_SCALE,
    maximumFractionDigits: MONEY_SCALE,
  });
}
