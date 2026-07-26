import { describe, it, expect } from 'vitest';
import { ToolCallRecorder, TOOL_OPERATORS, MAX_ARG_QUERY_CHARS, MAX_DETAIL_CHARS } from './tool-recorder';

/** Drive one tool call through the hooks the way Mastra's wrapToolWithHooks does. */
async function callTool(rec: ToolCallRecorder, name: string, input: any, outcome: { output?: any; error?: any }) {
  const h = rec.hooks();
  h.beforeToolCall({ toolName: name, input, context: {} });
  h.afterToolCall({ toolName: name, input, context: {}, ...outcome });
}

describe('ToolCallRecorder', () => {
  it('records one committed event per tool call with operator and capabilities', async () => {
    const rec = new ToolCallRecorder();
    rec.startAttempt();
    await callTool(rec, 'hybrid_search', { query: 'wire to shell co', k: 4 }, { output: { results: [1, 2, 3, 4] } });
    rec.commitAttempt();

    const events = rec.drain();
    expect(events).toHaveLength(1);
    expect(events[0].step).toBe('tool');
    expect(events[0].tool.name).toBe('hybrid_search');
    expect(events[0].tool.op).toBe('$rankFusion');
    expect(events[0].capabilities).toEqual(['hybrid', 'vector', 'fulltext']);
    expect(events[0].tool.ok).toBe(true);
    expect(events[0].tool.result_count).toBe(4);
    expect(events[0].tool.ms).toBeGreaterThanOrEqual(0);
    expect(events[0].headline).toBe('hybrid_search → 4 results');
  });

  it('stamps each event with its own completion instant, so the replay can pace them apart', async () => {
    const rec = new ToolCallRecorder();
    rec.startAttempt();
    await callTool(rec, 'search_text', { query: 'a' }, { output: { results: [] } });
    await new Promise(r => setTimeout(r, 12));
    await callTool(rec, 'hybrid_search', { query: 'b' }, { output: { results: [] } });
    rec.commitAttempt();

    const [first, second] = rec.drain();
    expect(first.ts).toBeInstanceOf(Date);
    expect(second.ts.getTime()).toBeGreaterThan(first.ts.getTime());
  });

  it('DISCARDS a failed attempt tool calls — the permanent record only carries the committed turn', async () => {
    const rec = new ToolCallRecorder();
    rec.startAttempt();
    await callTool(rec, 'hybrid_search', { query: 'a' }, { output: { results: [1] } });
    // attempt 1 produced no usable verdict — never committed
    rec.startAttempt();
    await callTool(rec, 'trace_funds', { account_id: 'ACC-1' }, { output: { network_size: 3 } });
    rec.commitAttempt();

    const names = rec.drain().map(e => e.tool.name);
    expect(names).toEqual(['trace_funds']);
  });

  it('drain() empties the recorder so a second case cannot inherit the first case calls', async () => {
    const rec = new ToolCallRecorder();
    rec.startAttempt();
    await callTool(rec, 'search_text', { query: 'a' }, { output: { results: [] } });
    rec.commitAttempt();
    expect(rec.drain()).toHaveLength(1);
    expect(rec.drain()).toHaveLength(0);
  });

  it('truncates args.query to 120 chars AT EMIT TIME', async () => {
    const rec = new ToolCallRecorder();
    rec.startAttempt();
    await callTool(rec, 'search_precedent', { query: 'x'.repeat(500), k: 5 }, { output: { results: [] } });
    rec.commitAttempt();

    const q = rec.drain()[0].tool.args.query as string;
    expect(q).toHaveLength(MAX_ARG_QUERY_CHARS);
    expect(q).toBe('x'.repeat(MAX_ARG_QUERY_CHARS));
  });

  it('records a throwing tool as ok:false rather than dropping the event', async () => {
    const rec = new ToolCallRecorder();
    rec.startAttempt();
    await callTool(rec, 'trace_funds', { account_id: 'ACC-9' }, { error: new Error('index missing') });
    rec.commitAttempt();

    const e = rec.drain()[0];
    expect(e.tool.ok).toBe(false);
    expect(e.tool.result_count).toBeNull();
    expect(e.headline).toBe('trace_funds → failed');
    expect(e.detail).toContain('index missing');
  });

  it('emits op:null with no capabilities for an unmapped tool, and does not throw', async () => {
    const rec = new ToolCallRecorder();
    rec.startAttempt();
    await expect(callTool(rec, 'brand_new_tool', { query: 'a' }, { output: { results: [] } })).resolves.toBeUndefined();
    rec.commitAttempt();

    const e = rec.drain()[0];
    expect(e.tool.op).toBeNull();
    expect(e.capabilities).toBeUndefined();
  });

  it('maps all five shipped tools', () => {
    expect(Object.keys(TOOL_OPERATORS).sort()).toEqual(
      ['hybrid_search', 'recall_verdicts', 'search_precedent', 'search_text', 'trace_funds'],
    );
    expect(TOOL_OPERATORS.search_precedent.op).toBe('$vectorSearch');
    expect(TOOL_OPERATORS.search_text.op).toBe('$search');
    expect(TOOL_OPERATORS.trace_funds.op).toBe('$graphLookup');
    expect(TOOL_OPERATORS.recall_verdicts.capabilities).toEqual(['memory']);
  });

  it('times INTERLEAVED calls to the same tool separately, so neither reports a false 0ms', async () => {
    const rec = new ToolCallRecorder();
    rec.startAttempt();
    const h = rec.hooks();
    // Mastra fans tool calls out concurrently, and two hybrid_search calls in one turn is normal for
    // this agent. Name-keyed timing had the second before() overwrite the first's start and the
    // first after() delete the entry, so call B reported 0ms — a lie shown next to $rankFusion.
    const inA = { query: 'a', k: 4 };
    const inB = { query: 'b', k: 4 };
    h.beforeToolCall({ toolName: 'hybrid_search', input: inA, context: {} });
    await new Promise(r => setTimeout(r, 12));
    h.beforeToolCall({ toolName: 'hybrid_search', input: inB, context: {} });
    await new Promise(r => setTimeout(r, 12));
    h.afterToolCall({ toolName: 'hybrid_search', input: inA, context: {}, output: { results: [1] } });
    await new Promise(r => setTimeout(r, 12));
    h.afterToolCall({ toolName: 'hybrid_search', input: inB, context: {}, output: { results: [2] } });
    rec.commitAttempt();

    const [a, b] = rec.drain();
    expect(a.tool.args.query).toBe('a');
    expect(b.tool.args.query).toBe('b');
    expect(a.tool.ms).toBeGreaterThan(0);
    expect(b.tool.ms).toBeGreaterThan(0);
    // A started first and finished first, so it must be the shorter of the two.
    expect(b.tool.ms).toBeGreaterThan(a.tool.ms);
  });

  it('does not throw when a call input is not an object, and still records the call', async () => {
    const rec = new ToolCallRecorder();
    rec.startAttempt();
    // A WeakMap key must be an object; a primitive/undefined input must degrade, never take the run
    // down. The recorder's whole contract is that a missing timing loses a number, not the case.
    await expect(callTool(rec, 'search_text', undefined, { output: { results: [1] } })).resolves.toBeUndefined();
    await expect(callTool(rec, 'search_text', 'not-an-object', { output: { results: [1] } })).resolves.toBeUndefined();
    rec.commitAttempt();

    const events = rec.drain();
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.tool.ms).toBeGreaterThanOrEqual(0);
      expect(e.tool.args).toEqual({});
    }
  });

  it('caps an enormous error detail at emit time, so it cannot be baked into the recording', async () => {
    const rec = new ToolCallRecorder();
    rec.startAttempt();
    await callTool(rec, 'trace_funds', { account_id: 'ACC-9' }, { error: new Error('index missing ' + 'x'.repeat(9000)) });
    rec.commitAttempt();

    const detail = rec.drain()[0].detail as string;
    expect(detail.length).toBeLessThanOrEqual(MAX_DETAIL_CHARS + 1);   // +1 for the ellipsis
    expect(detail).toContain('index missing');   // the useful prefix survives
  });

  it('counts trace_funds results from network_size, not a results array', async () => {
    const rec = new ToolCallRecorder();
    rec.startAttempt();
    await callTool(rec, 'trace_funds', { account_id: 'ACC-1' }, { output: { network_size: 7, layering: true, circular_flow: false, suspicious_patterns: true } });
    rec.commitAttempt();

    const e = rec.drain()[0];
    expect(e.tool.result_count).toBe(7);
    expect(e.headline).toBe('trace_funds → 7 hops');
  });
});
