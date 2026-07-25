import { describe, it, expect } from 'vitest';
import { checkReplayHealth } from './replay-health';
import { REPLAY_COLLECTIONS } from './replay-store';
import { TRANSACTIONS_COLLECTION } from '../mastra/schemas/transactions';

/** Events at fixed offsets (ms) from a base instant, one per step. */
function events(offsets: number[]) {
  const base = Date.UTC(2026, 5, 11, 0, 0, 0);
  return offsets.map((o, i) => ({ transaction_id: `txn-${i}`, step: 'reason', ts: new Date(base + o) }));
}

/** Offsets for a realistic run: n cases of triage→retrieve→recall→reason at `gap` ms of reasoning. */
function runOffsets(cases: number, gap: number) {
  const out: number[] = [];
  let t = 0;
  for (let c = 0; c < cases; c++) {
    for (const d of [0, 150, 5, gap]) { t += d; out.push(t); }
  }
  return out;
}

function fakeDb(opts: {
  analyses?: any[];
  events?: any[];
  corpus?: string[];
}) {
  const analyses = opts.analyses ?? [];
  const evs = opts.events ?? [];
  const corpus = (opts.corpus ?? []).map(id => ({ transaction_id: id }));
  return {
    collection(name: string) {
      if (name === REPLAY_COLLECTIONS.case_analysis) {
        return { find: () => ({ toArray: async () => analyses }) } as any;
      }
      if (name === REPLAY_COLLECTIONS.agent_events) {
        return { find: () => ({ sort: () => ({ toArray: async () => evs }) }) } as any;
      }
      if (name === TRANSACTIONS_COLLECTION) {
        return {
          countDocuments: async () => corpus.length,
          find: (filter: any) => {
            const want: string[] = filter.transaction_id.$in;
            return { toArray: async () => corpus.filter(d => want.includes(d.transaction_id)) };
          },
        } as any;
      }
      throw new Error(`unexpected collection ${name}`);
    },
  } as any;
}

const analysis = (precedents: string[], memory: string[] = []) => ({
  transaction_id: 'txn-review-high',
  precedents: precedents.map(id => ({ transaction_id: id })),
  memory: memory.map(id => ({ transaction_id: id })),
});

describe('checkReplayHealth — dangling precedents', () => {
  it('is clean when every cited id exists in the corpus', async () => {
    const db = fakeDb({
      analyses: [analysis(['txn-a', 'txn-b'], ['txn-a'])],
      events: events(runOffsets(2, 6000)),
      corpus: ['txn-a', 'txn-b', 'txn-c'],
    });
    const health = await checkReplayHealth(db);
    expect(health.danglingIds).toEqual([]);
    expect(health.ok).toBe(true);
  });

  it('flags cited ids missing from the corpus — the SEED_SCALE_COUNT mismatch', async () => {
    const db = fakeDb({
      analyses: [analysis(['txn-a', 'txn-syn-00675', 'txn-syn-01010'])],
      events: events(runOffsets(2, 6000)),
      corpus: ['txn-a'],
    });
    const health = await checkReplayHealth(db);
    expect(health.danglingIds.sort()).toEqual(['txn-syn-00675', 'txn-syn-01010']);
    expect(health.ok).toBe(false);
    expect(health.warnings.join(' ')).toMatch(/precedent id\(s\) cited by the recording are NOT in/);
  });

  it('checks recalled memory ids too, not just precedents', async () => {
    const db = fakeDb({
      analyses: [analysis(['txn-a'], ['txn-gone'])],
      events: events(runOffsets(2, 6000)),
      corpus: ['txn-a'],
    });
    expect((await checkReplayHealth(db)).danglingIds).toEqual(['txn-gone']);
  });

  it('tolerates a hard-compliance case with no precedents at all', async () => {
    const db = fakeDb({
      analyses: [{ transaction_id: 'txn-review-sanctions', precedents: [] }],
      events: events(runOffsets(2, 6000)),
      corpus: ['txn-a'],
    });
    const health = await checkReplayHealth(db);
    expect(health.danglingIds).toEqual([]);
    expect(health.ok).toBe(true);
  });
});

describe('checkReplayHealth — pacing staleness', () => {
  const clean = { analyses: [], corpus: ['txn-a'] };

  it('reports the recording span', async () => {
    const db = fakeDb({ ...clean, events: events([0, 1000, 2000, 8000]) });
    expect((await checkReplayHealth(db)).recordingSpanMs).toBe(8000);
  });

  it('does not judge timing when no live span is supplied', async () => {
    const db = fakeDb({ ...clean, events: events(runOffsets(3, 24000)) });
    const health = await checkReplayHealth(db);
    expect(health.warnings.join(' ')).not.toMatch(/live pipeline/);
  });

  it('flags a recording the live pipeline has clearly beaten', async () => {
    // 148s of recording against a 48s live run — the case that prompted this check.
    const db = fakeDb({ ...clean, events: events([0, 148_300]) });
    const health = await checkReplayHealth(db, { liveSpanMs: 48_300 });
    expect(health.ok).toBe(false);
    expect(health.warnings.join(' ')).toMatch(/live pipeline runs the same cases in 48.3s \(3.1x\)/);
  });

  it('accepts a recording within the tolerated ratio of the live run', async () => {
    const db = fakeDb({ ...clean, events: events(runOffsets(3, 6000)) });
    const health = await checkReplayHealth(db, { liveSpanMs: 18_000 });
    expect(health.warnings.join(' ')).not.toMatch(/live pipeline/);
  });

  it('flags a recording dominated by gaps past the client clamp', async () => {
    const db = fakeDb({ ...clean, events: events([0, 30_000, 60_000, 90_000, 120_000]) });
    const health = await checkReplayHealth(db);
    expect(health.clampedGaps).toBe(4);
    expect(health.warnings.join(' ')).toMatch(/exceed the client's 6000ms clamp/);
  });

  it('flags a recording so fast the pacing floors set the tempo', async () => {
    const db = fakeDb({ ...clean, events: events([0, 5, 10, 14, 19, 25, 30, 36]) });
    const health = await checkReplayHealth(db);
    expect(health.warnings.join(' ')).toMatch(/pacing\s+floors are setting the tempo/);
  });

  it('handles an empty recording without dividing by zero', async () => {
    const db = fakeDb({ ...clean, events: [] });
    const health = await checkReplayHealth(db);
    expect(health.recordingSpanMs).toBe(0);
    expect(health.ok).toBe(true);
  });
});
