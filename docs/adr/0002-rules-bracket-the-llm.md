# ADR 0002: Deterministic rules bracket the LLM

Status: accepted

## Context

An agent that investigates a financial transaction and then decides its disposition is an agent with
authority over money. The failure modes that matter are not hallucinated facts in a rationale. They
are an approve where a reject was mandatory, and a confident approve where the correct answer was "a
human should look at this".

The straightforward design is to let the agent decide and validate afterwards. That leaves two holes.
A hard compliance rule (a sanctions hit) becomes something the model is trusted not to override,
rather than something it never sees. And validation-after-the-fact has to be able to correct in both
directions, which means there is a code path that turns a stricter answer into a looser one.

## Decision

Deterministic code runs on both sides of the model, and only the code decides.

`triage(facts)` runs first, before any model call. A sanctions or watchlist hit returns a hard reject
with `decided_by: 'compliance'`, and the agent and policy judge are never invoked. No tokens are
spent and there is no code path where a model response sits between a hard rule and its outcome.

`reconcile(facts, verdict)` runs after the agent and has the final word. It escalates when any of
these hold:

| Condition | Constant |
|---|---|
| Amount in the structuring band, $4,900 to $4,999 inclusive | `STRUCTURING_FLOOR`, `STRUCTURING_CEILING` |
| Amount at or above $50,000 and the agent said approve | `HIGH_VALUE_THRESHOLD` |
| Fund tracing flagged a ring | from `$graphLookup` |
| Confidence at or below 85 | `LOW_CONFIDENCE_CEILING` |
| The agent itself asked to escalate | |

The guarantee is bounded auto-approval, not monotonicity: no agent output reaches an automatic
`approve` except a clear-cut approve above the confidence ceiling that matches no rule. An agent
`escalate` is always honoured, and it is honoured by an explicit rule (`agent_requested_escalation`)
rather than by falling through, because the fall-through only speaks approve and reject and an
escalate reaching it became an auto-approve.

"May only tighten" is the tempting phrasing and it is wrong, which earlier revisions of this ADR did
not catch. The `low_confidence` condition tests confidence alone, regardless of `recommendation`, so a
low-confidence *reject* also returns `escalate`, and escalate is a queue a human can approve from.
Reconciliation routes toward human review from both directions rather than strictly toward severity.

`decided_by` records which layer actually decided: `compliance` for a hard pre-model rule, `agent`
when a clear-cut recommendation was honoured, `reconciler` when a rule tightened it.

## Consequences

The set of things that can auto-approve is enumerable by reading one function. That is the property
worth having, and it does not degrade when the model, the prompt, or the provider changes.

Both rule functions are pure and synchronous. Every branch is unit tested without a model, a database,
or a network.

The rules duplicate judgement the model is also asked to apply. The structuring band, the high-value
threshold and the ring signal all appear in the prompt and in `reconcile`. That is redundancy on
purpose: the prompt makes the agent's reasoning better, and the rules make the outcome guaranteed.

Amount comparisons go through the money helpers rather than bare operators, so the same rule accepts a
`Decimal128` from the database, a number from a fixture, and a string from an API payload. See
[ADR 0008](0008-decimal128-money.md).

The band and the thresholds are named constants rather than literals at call sites, because a missed
call site is invisible.

Tightening-only means the rules cannot fix a false reject. If the agent wrongly rejects a legitimate
transaction, nothing downstream relaxes it. That is the correct direction to fail for this domain, and
it is a real limitation: recall over fraud is protected at the cost of precision over legitimate
traffic.
