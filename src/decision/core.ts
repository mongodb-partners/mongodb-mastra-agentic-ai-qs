import type { Lane } from '../mastra/schemas/transactions';

export type Disposition = 'approve' | 'reject' | 'escalate';

export interface TxnFacts {
  transaction_id: string;
  amount: number;
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

/** Structuring band: a deposit deliberately just under the $5,000 CTR reporting threshold. */
export function isStructuringAmount(amount: number): boolean {
  return amount >= 4900 && amount <= 4999;
}

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
 * a suspicious fund-tracing ring, or confidence at/below the low-confidence ceiling.
 */
export function reconcile(facts: TxnFacts, verdict: AgentVerdict): DecisionResult {
  const reasons: string[] = [];
  if (isStructuringAmount(facts.amount)) reasons.push('structuring_amount');
  if (facts.amount >= HIGH_VALUE_THRESHOLD && verdict.recommendation === 'approve') reasons.push('high_value_approval');
  if (facts.ring_suspicious) reasons.push('fraud_ring_suspicious');
  if (verdict.confidence <= LOW_CONFIDENCE_CEILING) reasons.push('low_confidence');

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
  // Clear-cut: honor the agent's approve/reject (never a bare "escalate" here — that's handled above).
  return {
    disposition: verdict.recommendation === 'reject' ? 'reject' : 'approve',
    decided_by: 'agent',
    confidence: verdict.confidence,
    risk_factors: verdict.risk_factors,
    rationale: verdict.rationale,
    must_escalate: false,
  };
}
