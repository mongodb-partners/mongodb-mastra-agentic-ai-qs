import { describe, it, expect } from 'vitest';
import { toolEventDoc, RUN_STATE_COLLECTIONS } from './run-engine';
import { RECORDING_COLLECTIONS, REPLAY_COLLECTIONS } from '../data/replay-store';
import { WORKFLOW_SNAPSHOT_COLLECTION } from './review-workflow';
import { TRANSACTIONS_COLLECTION } from '../mastra/schemas/transactions';

/**
 * The reset list is shared by the live-mode route and `bake-replay.ts`. These assertions are about
 * COVERAGE, not about two arrays matching: the bug they exist to catch is a collection the pipeline
 * writes that nobody clears, which folds prior run state into a recording published as immutable.
 */
describe('RUN_STATE_COLLECTIONS', () => {
  it('clears the durable workflow snapshot, whose runs point at the `reviews` docs it deletes', () => {
    expect(RUN_STATE_COLLECTIONS).toContain(WORKFLOW_SNAPSHOT_COLLECTION);
  });

  it('covers every collection the replay records — a recorded collection left behind survives a bake', () => {
    for (const c of RECORDING_COLLECTIONS) expect(RUN_STATE_COLLECTIONS).toContain(c);
  });

  it('never deletes the corpus or the immutable replay copies', () => {
    // A reset restores seed *statuses*; deleting `transactions` at 1M would drop ~998,800 synthetic
    // documents, and the `replay_*` copies are the only thing demo mode reads.
    expect(RUN_STATE_COLLECTIONS).not.toContain(TRANSACTIONS_COLLECTION);
    for (const c of Object.values(REPLAY_COLLECTIONS)) expect(RUN_STATE_COLLECTIONS).not.toContain(c);
  });

  it('lists each collection once, so a reset is not a double delete', () => {
    expect(new Set(RUN_STATE_COLLECTIONS).size).toBe(RUN_STATE_COLLECTIONS.length);
  });
});

describe('toolEventDoc', () => {
  const ev = {
    step: 'tool' as const,
    headline: 'hybrid_search → 4 results',
    detail: 'txn-a, txn-b',
    capabilities: ['hybrid', 'vector', 'fulltext'] as any,
    ts: new Date('2026-07-26T10:00:00.250Z'),
    tool: { name: 'hybrid_search', op: '$rankFusion', ms: 214, ok: true, args: { query: 'q', k: 4 }, result_count: 4 },
  };

  it('carries the run and transaction ids and PRESERVES the recorded completion instant', () => {
    const doc = toolEventDoc('run-1', 'txn-9', ev);
    expect(doc.run_id).toBe('run-1');
    expect(doc.transaction_id).toBe('txn-9');
    expect(doc.ts).toEqual(new Date('2026-07-26T10:00:00.250Z'));
    expect(doc.step).toBe('tool');
    expect(doc.tool.op).toBe('$rankFusion');
  });

  it('sets the scalar `capability` mirror the rail falls back to, like every other event', () => {
    expect(toolEventDoc('r', 't', ev).capability).toBe('hybrid');
  });

  it('omits capability entirely for an unmapped tool rather than writing undefined', () => {
    const unmapped = { ...ev, capabilities: undefined, tool: { ...ev.tool, op: null } };
    const doc = toolEventDoc('r', 't', unmapped as any);
    expect('capability' in doc).toBe(false);
    expect(doc.tool.op).toBeNull();
  });
});
