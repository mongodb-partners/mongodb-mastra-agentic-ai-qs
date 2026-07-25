import { describe, it, expect } from 'vitest';
import {
  triage, reconcile, isStructuringAmount, HIGH_VALUE_THRESHOLD,
  type TxnFacts, type AgentVerdict,
} from './core';

const facts = (o: Partial<TxnFacts> = {}): TxnFacts => ({
  transaction_id: 't', amount: 100, sender_account: 'A', ...o,
});
const verdict = (o: Partial<AgentVerdict> = {}): AgentVerdict => ({
  recommendation: 'approve', confidence: 95, risk_factors: [], rationale: 'clean', ...o,
});

describe('isStructuringAmount', () => {
  it('flags $4,900–$4,999', () => {
    expect(isStructuringAmount(4950)).toBe(true);
    expect(isStructuringAmount(4899)).toBe(false);
    expect(isStructuringAmount(5000)).toBe(false);
  });
});

describe('triage (deterministic pre-LLM)', () => {
  it('hard-rejects a sanctions hit without consulting the agent', () => {
    const r = triage(facts({ sanctions_hit: true }));
    expect(r?.disposition).toBe('reject');
    expect(r?.decided_by).toBe('compliance');
    expect(r?.confidence).toBe(100);
  });
  it('returns null when no hard rule fires (agent will reason)', () => {
    expect(triage(facts({ amount: 3000 }))).toBeNull();
  });
});

describe('reconcile (deterministic override of the agent)', () => {
  it('honors a clean-cut high-confidence approve', () => {
    const r = reconcile(facts({ amount: 3200 }), verdict({ recommendation: 'approve', confidence: 95 }));
    expect(r.disposition).toBe('approve');
    expect(r.decided_by).toBe('agent');
    expect(r.must_escalate).toBe(false);
  });
  it('forces escalate on a structuring amount even if the agent approved', () => {
    const r = reconcile(facts({ amount: 4950 }), verdict({ recommendation: 'approve', confidence: 99 }));
    expect(r.disposition).toBe('escalate');
    expect(r.risk_factors).toContain('structuring_amount');
  });
  it('forces escalate on a high-value approval', () => {
    const r = reconcile(facts({ amount: HIGH_VALUE_THRESHOLD + 1 }), verdict({ recommendation: 'approve', confidence: 99 }));
    expect(r.disposition).toBe('escalate');
    expect(r.risk_factors).toContain('high_value_approval');
  });
  it('forces escalate when trace_funds is suspicious', () => {
    const r = reconcile(facts({ ring_suspicious: true }), verdict({ recommendation: 'approve', confidence: 99 }));
    expect(r.disposition).toBe('escalate');
    expect(r.risk_factors).toContain('fraud_ring_suspicious');
  });
  it('forces escalate on low agent confidence', () => {
    const r = reconcile(facts({ amount: 3200 }), verdict({ recommendation: 'approve', confidence: 70 }));
    expect(r.disposition).toBe('escalate');
    expect(r.risk_factors).toContain('low_confidence');
  });
  it('honors a clear-cut reject', () => {
    const r = reconcile(facts({ amount: 2000 }), verdict({ recommendation: 'reject', confidence: 96 }));
    expect(r.disposition).toBe('reject');
    expect(r.decided_by).toBe('agent');
  });
  // Regression: a confident agent "escalate" with no policy trigger used to fall through to the
  // approve/reject line and silently become an APPROVE — the reconciler is only ever allowed to
  // tighten a verdict, never to loosen one.
  it('honors a high-confidence escalate that no policy rule would have caught', () => {
    const r = reconcile(facts({ amount: 3200 }), verdict({ recommendation: 'escalate', confidence: 86 }));
    expect(r.disposition).toBe('escalate');
    expect(r.must_escalate).toBe(true);
    expect(r.risk_factors).toContain('agent_requested_escalation');
  });
  it('never downgrades an escalate recommendation to approve at any confidence', () => {
    for (const confidence of [86, 90, 99, 100]) {
      const r = reconcile(facts({ amount: 3200 }), verdict({ recommendation: 'escalate', confidence }));
      expect(r.disposition).toBe('escalate');
    }
  });
});
