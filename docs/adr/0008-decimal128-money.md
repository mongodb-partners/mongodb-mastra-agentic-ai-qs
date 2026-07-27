# ADR 0008: `amount` is `Decimal128`, behind one module

Status: accepted

## Context

`amount` is money. It is compared against a structuring band and a high-value threshold, hashed into an
evidence digest, displayed, and shipped over JSON. A binary double represents most currency values
approximately, and the error shows up as an off-by-a-cent total or a comparison that lands on the wrong
side of a boundary. Floats work until they do not, and then silently.

## Decision

Store `amount` as BSON `Decimal128` in `transactions`, `case_decisions`, and the benchmark corpus, and
route every operation on it through one module, [`src/money.ts`](../../src/money.ts). That module is the
only place in the codebase that knows the type.

Its surface: `toMoney` normalizes any money-like value to two decimal places, `moneyToNumber` converts
for display and JSON, `compareMoney` / `moneyAtLeast` / `moneyAtMost` compare, `formatMoney` renders.
Conversion goes through the decimal *string* in every branch, never through a binary float.

One field is deliberately excluded. The evidence snapshot's `amount` is a plain `number`. See below.

## Consequences

Three things about `Decimal128` in JavaScript fail quietly, and each one shaped part of the API:

`z.number().safeParse(d).success` is `false`. A Zod money field has to be a union, or validation
rejects the value the database just returned.

`JSON.stringify(d)` emits `{"$numberDecimal":"1256.00"}`, an object rather than a number. A client doing
arithmetic on the parsed value gets `NaN`. This is why API payloads carry `moneyToNumber` output.

`Decimal128` is not value-canonical. `fromString('1256')` and `fromString('1256.00')` are numerically
equal with different bytes and different `toString()`. Anything that hashes, key-matches, or
byte-compares an amount must call `toMoney` first, which is the trap that motivates fixing the scale at
two places.

That last one is why the evidence snapshot stores a plain number. `canonicalize` walks own enumerable
properties, and a `Decimal128`'s only own property is `bytes`, so hashing one makes the digest a
function of the byte encoding. The same amount could then produce two different evidence hashes and a
valid human approval would be refused as stale. See [ADR 0006](0006-evidence-bound-human-review.md).

One expected problem turned out not to be one, and saying so is more useful than implying the helpers
rescue a broken operator. A bare `d >= 4900` gives the right answer: the relational operator calls
`toString()`, and a string-against-number comparison coerces numerically. Verified across 50000.00,
1256.00, 4900.00, 4899.99, 0.00, -5.00, and 1e30, all agreeing with the numeric result. So
`compareMoney` and friends exist for readability and for accepting mixed input types, not to fix an
operator. What genuinely breaks is *equality*: `===` is reference equality, so two `Decimal128`s holding
the same value are never equal.

`moneyToNumber` is lossy in principle and sound for the range this app handles, since every amount is
well inside 2^53 at two decimal places. It should not be used to accumulate a running total over many
rows. Aggregate in the database.

Migrating an existing corpus is a real operation, not a type annotation. It was applied across all three
databases, and there is a byte-level detail worth knowing: a server-side `$convert` and a client-side
`toMoney` do not necessarily produce identical bytes for the same value, for the non-canonicality reason
above. Normalize on one path.
