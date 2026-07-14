import { describe, it, expect } from 'vitest';
import { buildScorecard, medianCaseSpanMs } from './stats';

describe('buildScorecard', () => {
  it('scores dispositions against the lane ground truth', () => {
    const card = buildScorecard([
      { transaction_id: 'a', lane: 'clean_approve', disposition: 'approve' },
      { transaction_id: 'b', lane: 'sanctions', disposition: 'reject' },
      { transaction_id: 'c', lane: 'structuring', disposition: 'escalate' },
      { transaction_id: 'd', lane: 'ring', disposition: 'escalate' },
    ]);
    expect(card).not.toBeNull();
    expect(card!.n).toBe(4);
    expect(card!.accuracy).toBe(1);
    expect(card!.fraudRecall).toBe(1);
    expect(card!.f1Macro).toBe(1);
  });

  it('counts a missed fraud case against fraud recall', () => {
    const card = buildScorecard([
      { transaction_id: 'a', lane: 'sanctions', disposition: 'approve' }, // miss
      { transaction_id: 'b', lane: 'ring', disposition: 'escalate' },
    ]);
    expect(card!.fraudRecall).toBe(0.5);
    expect(card!.accuracy).toBe(0.5);
  });

  it('ignores rows with unknown lanes or dispositions and returns null when empty', () => {
    expect(buildScorecard([])).toBeNull();
    expect(buildScorecard([{ transaction_id: 'x', lane: 'nope', disposition: 'approve' }])).toBeNull();
    expect(buildScorecard([{ transaction_id: 'x', lane: 'ring', disposition: 'held' }])).toBeNull();
  });
});

describe('medianCaseSpanMs', () => {
  it('returns null for no spans', () => expect(medianCaseSpanMs([])).toBeNull());
  it('returns the middle value for odd counts', () => expect(medianCaseSpanMs([300, 100, 200])).toBe(200));
  it('averages the middle pair for even counts', () => expect(medianCaseSpanMs([100, 200, 300, 400])).toBe(250));
});
