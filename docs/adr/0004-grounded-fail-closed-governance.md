# ADR 0004: Governance is grounded in retrieved policy and fails closed

Status: accepted

## Context

After the agent produces a verdict, a second model call judges it against regulatory policy. Two
things can go wrong, and both produce output that looks fine.

The judge can cite a policy that does not exist. A fabricated regulation code in a compliance
rationale is worse than no rationale, because it survives review by looking authoritative.

The judge can fail to produce parseable structured output. An empty violation list is
indistinguishable from a clean pass. Treating a parse failure as "no violations found" turns every
model hiccup into an automatic approval, and the approval carries a compliance score that says it was
checked.

## Decision

Three constraints, all enforced in code rather than in the prompt.

**Citations are grounded.** The judge is given the policies retrieved by `$vectorSearch` over
`policies`, filtered to `is_current_version: true`. Any citation in its response that is not in that
retrieved set is dropped and recorded in `dropped_citations` on the review record. The judge cannot
invent a regulation to justify a hold, and an attempt is preserved rather than discarded.

**Severity comes from the store, not the model.** Each violation's severity is read from the stored
policy document, not from the judge's classification. A judge calling a `critical` rule `low` cannot
under-penalize. Scoring is then arithmetic: 1.0 minus the summed penalties, where `low` is 0.05,
`medium` 0.15, `high` 0.25, and `critical` 0.4, with the hold threshold below 0.7.

**Missing structured output fails closed.** If the judge produces no valid structured output after 3
attempts, the case is held with a compliance score of 0 and a reason recording the failure. It does not
pass.

## Consequences

The compliance score is reproducible from stored data. Given the same retrieved policies and the same
set of violated policy codes, the arithmetic yields the same number regardless of which model ran.

A provider outage or a malformed response holds cases instead of approving them. That is a real
operational cost: a sustained failure of the judge turns into a queue of held cases needing human
review, rather than throughput. It is the correct direction for a compliance gate, and it should be
monitored, because the symptom of the failure is a growing review queue rather than an error rate.

The retry matters more than it looks. Structured output from a model is not reliably present:
`structuredOutput` was observed returning `undefined` roughly 1 call in 5 against one provider. Without
the retry, the fail-closed path would fire on healthy traffic and the hold queue would be mostly noise.

`dropped_citations` is worth reading in aggregate. A judge that repeatedly cites policies outside the
retrieved set is a signal about retrieval coverage, not only about the model.

Governance is 16.1% of a case's wall clock, second only to the agent itself. Grounding does not cost
that; the extra model call does. Skipping the judge would be the largest single latency saving
available and it is not on the table.
