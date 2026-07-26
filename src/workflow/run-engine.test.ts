import { describe, it, expect } from 'vitest';
import { toolEventDoc } from './run-engine';

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
