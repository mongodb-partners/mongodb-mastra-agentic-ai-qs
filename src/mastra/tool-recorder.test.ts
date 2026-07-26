import { describe, it, expect } from 'vitest';
import { ToolCallRecorder, TOOL_OPERATORS, MAX_ARG_QUERY_CHARS } from './tool-recorder';

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
