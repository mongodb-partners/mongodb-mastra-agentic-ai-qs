import { describe, it, expect } from 'vitest';
import { scoreEval, type EvalCase } from './metrics';

const c = (lane: string, expected: any, actual: any): EvalCase => ({ transaction_id: lane, lane, expected, actual });

describe('scoreEval', () => {
  it('scores a perfect run', () => {
    const r = scoreEval([
      c('clean_approve', 'approve', 'approve'),
      c('structuring', 'escalate', 'escalate'),
      c('clear_reject', 'reject', 'reject'),
    ]);
    expect(r.accuracy).toBe(1);
    expect(r.fraudRecall).toBe(1);
    expect(r.perClass.find(p => p.label === 'escalate')!.f1).toBe(1);
  });

  it('penalizes a missed fraud (fraudRecall drops when a fraud case is approved)', () => {
    const r = scoreEval([
      c('clean_approve', 'approve', 'approve'),
      c('structuring', 'escalate', 'approve'), // MISS: fraud let through
    ]);
    expect(r.fraudRecall).toBe(0);   // the one fraud case was not caught
    expect(r.accuracy).toBe(0.5);
  });

  it('builds a confusion matrix', () => {
    const r = scoreEval([
      c('structuring', 'escalate', 'reject'),
      c('structuring', 'escalate', 'escalate'),
    ]);
    expect(r.confusion.escalate.reject).toBe(1);
    expect(r.confusion.escalate.escalate).toBe(1);
  });

  it('reports per-lane recall', () => {
    const r = scoreEval([
      c('ring', 'escalate', 'escalate'),
      c('ring', 'escalate', 'approve'),
    ]);
    expect(r.perLane.find(l => l.lane === 'ring')!.recall).toBe(0.5);
  });
});
