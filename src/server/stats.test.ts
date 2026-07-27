import { describe, it, expect } from 'vitest';
import {
  buildScorecard, caseSpansMs, medianCaseSpanMs,
  percentile, buildStagePercentiles, stageDurationsMs, buildStageShare, MIN_TAIL_N,
} from './stats';

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

describe('percentile', () => {
  it('interpolates on the sorted sample', () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25);
    expect(percentile([10, 20, 30, 40], 0)).toBe(10);
    expect(percentile([10, 20, 30, 40], 1)).toBe(40);
  });

  it('returns the only value for a single-element sample', () => {
    expect(percentile([10], 0.99)).toBe(10);
  });
});

describe('buildStagePercentiles', () => {
  it('reports n alongside every percentile', () => {
    const r = buildStagePercentiles(Array.from({ length: 200 }, (_, i) => i + 1))!;
    expect(r.n).toBe(200);
    expect(r.p50).toBe(100.5);
    expect(r.p95).not.toBeNull();
    expect(r.p99).not.toBeNull();
  });

  it('SUPPRESSES p95/p99 below the minimum sample size rather than emitting a fake one', () => {
    // At n=10 the "p99" is arithmetically the max — one unlucky sample dressed up as a tail
    // statistic. Publishing it is misreporting, so it must be null, while p50 stays valid
    // and n stays visible so a reader can check the claim rather than trust it.
    const r = buildStagePercentiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])!;
    expect(r.n).toBe(10);
    expect(r.p50).toBe(5.5);
    expect(r.p95).toBeNull();
    expect(r.p99).toBeNull();
  });

  it('publishes the tail exactly at the threshold, not one sample later', () => {
    const r = buildStagePercentiles(Array.from({ length: MIN_TAIL_N }, (_, i) => i + 1))!;
    expect(r.n).toBe(MIN_TAIL_N);
    expect(r.p99).not.toBeNull();
    const below = buildStagePercentiles(Array.from({ length: MIN_TAIL_N - 1 }, (_, i) => i + 1))!;
    expect(below.p99).toBeNull();
  });

  it('returns null for an empty sample', () => {
    expect(buildStagePercentiles([])).toBeNull();
  });
});

describe('stageDurationsMs', () => {
  it('measures each step as the gap to the next event in the same run', () => {
    const events = [
      { transaction_id: 'T1', step: 'triage', ts: 1000, run_id: 'r1' },
      { transaction_id: 'T1', step: 'retrieve', ts: 1100, run_id: 'r1' },
      { transaction_id: 'T1', step: 'reason', ts: 1500, run_id: 'r1' },
      { transaction_id: 'T1', step: 'commit', ts: 2000, run_id: 'r1' },
    ];
    const d = stageDurationsMs(events as any);
    expect(d.triage).toEqual([100]);
    expect(d.retrieve).toEqual([400]);
    expect(d.reason).toEqual([500]);
    // The last event has no successor, so `commit` gets no duration rather than a fabricated one.
    expect(d.commit).toBeUndefined();
  });

  it('never measures a duration across a run boundary', () => {
    // The same bug class caseSpansMs already guards: agent_events accumulates across runs, so a
    // naive gap would measure the idle time between them as work (573s once observed live).
    const events = [
      { transaction_id: 'T1', step: 'retrieve', ts: 1000, run_id: 'r1' },
      { transaction_id: 'T1', step: 'triage', ts: 600_000, run_id: 'r2' },
      { transaction_id: 'T1', step: 'retrieve', ts: 600_100, run_id: 'r2' },
      { transaction_id: 'T1', step: 'reason', ts: 600_400, run_id: 'r2' },
    ];
    const d = stageDurationsMs(events as any);
    expect(d.retrieve).toEqual([300]);
    expect(d.retrieve.some(v => v > 60_000)).toBe(false);
  });

  it('splits on a repeated opening step with no run_id, as baked replays predate run ids', () => {
    const d = stageDurationsMs([
      { transaction_id: 'T1', step: 'retrieve', ts: 1000 },
      { transaction_id: 'T1', step: 'triage', ts: 600_000 },
      { transaction_id: 'T1', step: 'retrieve', ts: 600_100 },
      { transaction_id: 'T1', step: 'reason', ts: 600_400 },
    ] as any);
    expect(d.retrieve).toEqual([300]);
  });

  it('keeps cases separate even when their events interleave', () => {
    const d = stageDurationsMs([
      { transaction_id: 'A', step: 'retrieve', ts: 1000, run_id: 'r1' },
      { transaction_id: 'B', step: 'retrieve', ts: 1050, run_id: 'r1' },
      { transaction_id: 'A', step: 'reason', ts: 1200, run_id: 'r1' },
      { transaction_id: 'B', step: 'reason', ts: 1450, run_id: 'r1' },
    ] as any);
    expect(d.retrieve.sort((a, b) => a - b)).toEqual([200, 400]);
  });

  it('drops unusable timestamps rather than emitting NaN durations', () => {
    const d = stageDurationsMs([
      { transaction_id: 'T1', step: 'retrieve', ts: 'not-a-date', run_id: 'r1' },
      { transaction_id: 'T1', step: 'reason', ts: 1200, run_id: 'r1' },
      { transaction_id: 'T1', step: 'commit', ts: 1500, run_id: 'r1' },
    ] as any);
    expect(d.retrieve).toBeUndefined();
    expect(d.reason).toEqual([300]);
  });
});

describe('buildStageShare', () => {
  it('reports each stage share of summed stage time', () => {
    const share = buildStageShare({ retrieve: [100, 100], reason: [800] })!;
    expect(share.retrieve).toBe(0.2);
    expect(share.reason).toBe(0.8);
  });

  it('returns null when there is no measured time to apportion', () => {
    expect(buildStageShare({})).toBeNull();
    expect(buildStageShare({ retrieve: [0] })).toBeNull();
  });
});
