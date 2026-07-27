import type { Lane } from '../mastra/schemas/transactions';
import { moneyAtLeast, moneyAtMost, type MoneyLike } from '../money';

export type Disposition = 'approve' | 'reject' | 'escalate';

export interface TxnFacts {
  transaction_id: string;
  amount: MoneyLike;
  lane?: Lane;
  sender_account: string;
  sanctions_hit?: boolean;   // set by a screening step (Plan 4 wires the real check)
  ring_suspicious?: boolean; // from trace_funds
}

/** The agent's proposed verdict (typed; code reconciles it — the LLM never has the final word). */
export interface AgentVerdict {
  recommendation: Disposition;
  confidence: number; // 0..100
  risk_factors: string[];
  rationale: string;
}

export interface DecisionResult {
  disposition: Disposition;
  decided_by: 'rules' | 'compliance' | 'agent' | 'reconciler';
  confidence: number;
  risk_factors: string[];
  rationale: string;
  must_escalate: boolean;
}

/**
 * Structuring band: a synthetic band for a deposit sized to sit just under a round reporting
 * threshold. The bounds are demo fixtures, not any jurisdiction's actual filing threshold.
 *
 * Takes MoneyLike and compares through the money helpers so the same rule accepts a Decimal128
 * from the DB, a number from a fixture, and a string from an API payload. (A bare `amount >= 4900`
 * on a Decimal128 does give the right answer — the operator stringifies and the comparison then
 * coerces numerically — so this is a readability and input-tolerance choice, not a bug fix.) The
 * band lives here rather than at the five call sites because a missed call site is invisible.
 */
export function isStructuringAmount(amount: MoneyLike): boolean {
  return moneyAtLeast(amount, STRUCTURING_FLOOR) && moneyAtMost(amount, STRUCTURING_CEILING);
}

/** Inclusive bounds of the structuring band. Named so the band is greppable and testable. */
export const STRUCTURING_FLOOR = 4900;
export const STRUCTURING_CEILING = 4999;

export const HIGH_VALUE_THRESHOLD = 50000;
export const LOW_CONFIDENCE_CEILING = 85; // at/below this, a clear-cut auto-decision is not allowed

/**
 * Deterministic pre-LLM triage. Runs BEFORE the agent. A hard compliance hit short-circuits to a
 * reject (the LLM is never consulted). Otherwise returns null → the agent reasons, then
 * `reconcile` has the final word. This "rules + compliance bracket the LLM" shape is carried
 * from the author's prior fraud app.
 */
export function triage(facts: TxnFacts): DecisionResult | null {
  if (facts.sanctions_hit) {
    return {
      disposition: 'reject',
      decided_by: 'compliance',
      confidence: 100,
      risk_factors: ['sanctions_screening_hit'],
      rationale: 'Counterparty matched a sanctions watchlist. Hard compliance reject; agent not consulted.',
      must_escalate: false,
    };
  }
  return null;
}

/**
 * Reconcile the agent's proposed verdict with deterministic policy. Even a confident agent
 * "approve" is forced to escalate when ANY of these hold: structuring band, high value,
 * a suspicious fund-tracing ring, confidence at/below the low-confidence ceiling, or the agent
 * itself asking for a human.
 *
 * The guarantee is narrower than "this can only tighten", so state it precisely: no agent output
 * reaches an automatic `approve` except a clear-cut approve above the confidence ceiling that
 * matches no rule. That holds unconditionally, and it is the property worth relying on.
 *
 * What does NOT hold is general monotonicity. The `low_confidence` check below fires on confidence
 * alone, regardless of `recommendation`, so a low-confidence `reject` also returns `escalate` — and
 * escalate is a queue a human can approve from. Routing is toward human review from both
 * directions, not strictly toward severity. An agent "escalate" is always honored.
 */
export function reconcile(facts: TxnFacts, verdict: AgentVerdict): DecisionResult {
  const reasons: string[] = [];
  if (isStructuringAmount(facts.amount)) reasons.push('structuring_amount');
  if (moneyAtLeast(facts.amount, HIGH_VALUE_THRESHOLD) && verdict.recommendation === 'approve') reasons.push('high_value_approval');
  if (facts.ring_suspicious) reasons.push('fraud_ring_suspicious');
  if (verdict.confidence <= LOW_CONFIDENCE_CEILING) reasons.push('low_confidence');
  // A confident escalate matches no rule above, and the fall-through below only speaks
  // approve/reject — without this the agent's request for review became an auto-approve.
  if (verdict.recommendation === 'escalate') reasons.push('agent_requested_escalation');

  const mustEscalate = reasons.length > 0;
  if (mustEscalate) {
    return {
      disposition: 'escalate',
      decided_by: 'reconciler',
      confidence: verdict.confidence,
      risk_factors: [...new Set([...verdict.risk_factors, ...reasons])],
      rationale: verdict.rationale,
      must_escalate: true,
    };
  }
  // Clear-cut: honor the agent's approve/reject. An "escalate" cannot reach here — it always adds
  // the agent_requested_escalation reason above.
  return {
    disposition: verdict.recommendation === 'reject' ? 'reject' : 'approve',
    decided_by: 'agent',
    confidence: verdict.confidence,
    risk_factors: verdict.risk_factors,
    rationale: verdict.rationale,
    must_escalate: false,
  };
}
