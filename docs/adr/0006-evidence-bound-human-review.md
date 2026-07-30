# ADR 0006: Human review is bound by an evidence hash

Status: accepted

## Context

When a case is held for human review, the run suspends and a reviewer decides later. Later can mean
minutes or days. In between, the evidence can change: a new decision lands, a policy is edited and
the compliance score moves, an amount is corrected.

The naive resume is "find the review, apply the human's approve or reject, commit". That commits an
approval against evidence the reviewer never saw. The failure is quiet, because the record shows a
human approved the case and says nothing about what was on screen at the time.

Storing the snapshot and comparing it to itself does not fix this. It proves the snapshot has not
changed, which it has not, because it is a stored copy. The comparison has to be against current state.

## Decision

The suspend path builds an `EvidenceSnapshot` and stores both the snapshot and
`evidence_hash = sha256(canonicalize(snapshot))`. The snapshot holds exactly what the decision depends
on: transaction id, proposed disposition, amount, risk factors, compliance score.

On resume, the server re-derives a snapshot from *current* state, hashes it, and compares it against
the `evidence_hash` stored on the review. On a match it commits with `reviewed_by: 'human'`. On a
mismatch it returns `rejected_stale` and commits nothing.

The stored hash is the server's own, not one the client sends. `POST /api/reviews/:id/resolve` accepts
only `{ decision }`, so a caller cannot present a hash and cannot influence which one is compared.

The suspend is durable in the database, not in process memory. A restart between hold and resolve
loses nothing.

Amended (2026-07-30): the hold is now additionally a suspended Mastra workflow run
([`../../src/workflow/review-workflow.ts`](../../src/workflow/review-workflow.ts)), persisted to
`mastra_workflow_snapshot`, and `reviews.workflow_run_id` links the two. Nothing in this decision
changes. The engine supplies typed suspend/resume payloads and one addressable run; it does not
take over the commit. On resume the step delegates to the same `resolveReview`, so the hash is
still re-derived from current state, the stale refusal still happens there, and the route keeps its
atomic claim — the engine's own double-resume rejection fires too late to replace it, and would not
cover a case suspended before this shipped. Starting the run is optional and additive: if it fails,
the hold degrades to exactly the behaviour described above.

## Consequences

An approval is bound to a specific set of facts. If anything the derived snapshot depends on moved, the
approval is refused and the reviewer sees the case again with current evidence. That holds across
process restarts and across deploys.

**What "current state" reaches is narrower than the snapshot suggests.** `deriveEvidenceSnapshot`
re-reads `amount` from `transactions`; the disposition, risk factors, and compliance score come back
from the stored `case_analysis` document. So a corrected amount is caught. A policy edited in the
`policies` collection is caught only once something re-scores the case and rewrites `case_analysis`,
because nothing in the resolve path re-runs governance. Widening the check would mean re-running the
reviewer at resolve time, which costs an LLM call per approval.

One fallback is worth knowing about. If derivation returns null, because the analysis or the
transaction is gone, the endpoint compares against the stored snapshot instead. That comparison always
matches, so a case whose transaction was deleted commits rather than refusing. The alternative,
failing the approval, strands the review with nothing a reviewer can do about it.

`POST /api/reviews/:id/resolve` therefore has two distinct 409s, and they mean different things.
`already_resolved` means someone else got there first, resolved atomically by a claim so two reviewers
cannot both commit. `rejected_stale` means the evidence moved. Collapsing them into one status would
tell a reviewer to retry when retrying cannot work, or the reverse.

The snapshot's `amount` field is a plain `number`, deliberately, even though `transactions.amount` is a
`Decimal128`. `canonicalize` walks own enumerable properties, and a `Decimal128`'s only own property is
`bytes`, so hashing one directly makes the digest a function of the byte encoding. `Decimal128` is not
value-canonical: `4950` and `4950.00` are numerically equal with different bytes. Hashing the raw value
would let the same amount produce two different evidence hashes, and the endpoint would refuse a
perfectly valid approval as stale. Callers normalize with `moneyToNumber` when building a snapshot. See
[ADR 0008](0008-decimal128-money.md).

That normalization also keeps the frozen digests in the committed replay fixtures valid, which was
verified rather than assumed: normalizing reproduces them exactly.

There is a related ordering rule in the suspend path. A hard compliance decision, a sanctions reject,
is terminal, and a governance hold must not suspend it into human review. Only non-hard decisions
honour `held`. Otherwise the strictest possible outcome becomes a question for a reviewer.

The cost is that a reviewer can lose work. Approving a case whose policy was edited while it sat in the
queue means deciding again. Refusing is still correct: the alternative is an audit record asserting a
human approved something they did not see.
