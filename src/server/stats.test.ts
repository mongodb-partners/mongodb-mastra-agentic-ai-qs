import { describe, it, expect } from 'vitest';
import { buildScorecard, caseSpansMs, medianCaseSpanMs } from './stats';

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

describe('caseSpansMs', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 6, 25, 0, 0, s)).toISOString();

  it('measures one span per case from its first to its last event', () => {
    expect(caseSpansMs([
      { transaction_id: 'a', step: 'triage', ts: at(0), run_id: 'r1' },
      { transaction_id: 'a', step: 'retrieve', ts: at(1), run_id: 'r1' },
      { transaction_id: 'a', step: 'commit', ts: at(7), run_id: 'r1' },
    ])).toEqual([7000]);
  });

  it('interleaves cases without mixing their spans', () => {
    expect(caseSpansMs([
      { transaction_id: 'a', step: 'triage', ts: at(0), run_id: 'r1' },
      { transaction_id: 'b', step: 'triage', ts: at(1), run_id: 'r1' },
      { transaction_id: 'a', step: 'commit', ts: at(6), run_id: 'r1' },
      { transaction_id: 'b', step: 'commit', ts: at(11), run_id: 'r1' },
    ]).sort((x, y) => x - y)).toEqual([6000, 10000]);
  });

  // THE REGRESSION: on the live box a case re-run 9 minutes later reported a single 573 s span, and
  // the median over six cases came out at 290 867 ms while every case really took 6–9 s.
  it('splits a case investigated in two runs instead of spanning the idle gap', () => {
    const spans = caseSpansMs([
      { transaction_id: 'a', step: 'triage', ts: at(0), run_id: 'r1' },
      { transaction_id: 'a', step: 'commit', ts: at(7), run_id: 'r1' },
      { transaction_id: 'a', step: 'triage', ts: at(580), run_id: 'r2' },
      { transaction_id: 'a', step: 'commit', ts: at(589), run_id: 'r2' },
    ]);
    expect(spans).toEqual([7000, 9000]);
    expect(medianCaseSpanMs(spans)).toBe(8000);
  });

  it('splits on a repeated opening step even with no run_id (baked replays predate it)', () => {
    expect(caseSpansMs([
      { transaction_id: 'a', step: 'triage', ts: at(0) },
      { transaction_id: 'a', step: 'commit', ts: at(7) },
      { transaction_id: 'a', step: 'triage', ts: at(580) },
      { transaction_id: 'a', step: 'commit', ts: at(589) },
    ])).toEqual([7000, 9000]);
  });

  it('splits on a run_id change even when the opening step is missing', () => {
    expect(caseSpansMs([
      { transaction_id: 'a', step: 'retrieve', ts: at(0), run_id: 'r1' },
      { transaction_id: 'a', step: 'commit', ts: at(7), run_id: 'r1' },
      { transaction_id: 'a', step: 'retrieve', ts: at(580), run_id: 'r2' },
      { transaction_id: 'a', step: 'commit', ts: at(589), run_id: 'r2' },
    ])).toEqual([7000, 9000]);
  });

  it('drops zero-length and unusable events rather than reporting a 0 ms case', () => {
    expect(caseSpansMs([
      { transaction_id: 'a', step: 'triage', ts: at(0), run_id: 'r1' }, // single event -> no span
      { transaction_id: '', step: 'triage', ts: at(1), run_id: 'r1' },
      { transaction_id: 'c', step: 'triage', ts: 'not-a-date', run_id: 'r1' },
      { transaction_id: 'c', step: 'commit', ts: at(3), run_id: 'r1' },
    ])).toEqual([]);
  });

  it('accepts Date and epoch-millis timestamps, not just ISO strings', () => {
    expect(caseSpansMs([
      { transaction_id: 'a', step: 'triage', ts: new Date(1_000), run_id: 'r1' },
      { transaction_id: 'a', step: 'commit', ts: 8_000, run_id: 'r1' },
    ])).toEqual([7000]);
  });

  it('returns no spans for no events', () => expect(caseSpansMs([])).toEqual([]));
});

describe('medianCaseSpanMs', () => {
  it('returns null for no spans', () => expect(medianCaseSpanMs([])).toBeNull());
  it('returns the middle value for odd counts', () => expect(medianCaseSpanMs([300, 100, 200])).toBe(200));
  it('averages the middle pair for even counts', () => expect(medianCaseSpanMs([100, 200, 300, 400])).toBe(250));
});
