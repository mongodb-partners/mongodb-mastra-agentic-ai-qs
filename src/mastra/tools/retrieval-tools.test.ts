import { describe, it, expect } from 'vitest';
import { buildRetrievalTools } from './retrieval-tools';

// A stub RetrievalService with the five methods the tools call.
const stub = {
  vector: async (_q: string, k = 5) => Array.from({ length: k }, (_, i) => ({
    transaction_id: `v${i}`, text: 'narrative', amount: 1, currency: 'USD',
    sender: { name: 's', account_number: 'A' }, recipient: { name: 'r', account_number: 'B' },
    status: 'rejected', lane: 'structuring',
  })),
  lexical: async () => [{ transaction_id: 'lx', text: 't', amount: 1, currency: 'USD', sender: { name: 's', account_number: 'A' }, recipient: { name: 'r', account_number: 'B' }, status: 'approved', lane: 'clean_approve' }],
  hybrid: async () => [{ transaction_id: 'hy', text: 't', amount: 1, currency: 'USD', sender: { name: 's', account_number: 'A' }, recipient: { name: 'r', account_number: 'B' }, status: 'escalated', lane: 'ring' }],
  traceFunds: async (_acct: string, depth?: number) => ({
    network_size: 3, unique_accounts: 3, circular_flow: true, layering: true,
    suspicious_patterns: true, depth_used: depth,
  }),
} as any;

const tools = buildRetrievalTools(stub);

async function run(tool: any, input: any) {
  return tool.execute(input, {} as any);
}

describe('retrieval tools', () => {
  it('exposes the five expected tool ids', () => {
    expect(tools.searchPrecedent.id).toBe('search_precedent');
    expect(tools.searchText.id).toBe('search_text');
    expect(tools.hybridSearch.id).toBe('hybrid_search');
    expect(tools.traceFunds.id).toBe('trace_funds');
    expect(tools.recallVerdicts.id).toBe('recall_verdicts');
  });

  it('search_precedent returns vector results', async () => {
    const r = await run(tools.searchPrecedent, { query: 'structuring', k: 2 });
    expect(r.results).toHaveLength(2);
  });

  it('trace_funds returns ring signals', async () => {
    const r = await run(tools.traceFunds, { account_id: 'ACC-RING-A' });
    expect(r.suspicious_patterns).toBe(true);
    expect(r.depth_used).toBe(3);
  });

  it('REFUSES an over-deep trace request rather than running it', async () => {
    // At 1M documents a depth-6 traversal failed 50% of the time on $graphLookup's 100MB memory
    // limit, so depth must be bounded at 3. Mastra validates inputSchema BEFORE execute, so an
    // out-of-range depth never reaches the service at all: the tool returns a corrective error the
    // model can retry from. Asserting that, rather than a clamped result, is what actually happens.
    const r = await run(tools.traceFunds, { account_id: 'ACC-RING-A', max_depth: 6 });
    expect(r.error).toBe(true);
    expect(r.message).toMatch(/max_depth/);
    expect(r.depth_used).toBeUndefined();
  });

  it('leaves a shallower request alone', async () => {
    const r = await run(tools.traceFunds, { account_id: 'ACC-RING-A', max_depth: 1 });
    expect(r.depth_used).toBe(1);
  });

  it('declares the clamped bound in its schema, so the model is told the real limit', () => {
    // Declaring 6 while clamping to 3 would silently ignore what the model asked for.
    const shape = (tools.traceFunds.inputSchema as any).shape;
    expect(shape.max_depth.safeParse(3).success).toBe(true);
    expect(shape.max_depth.safeParse(4).success).toBe(false);
  });

  it('recall_verdicts cites prior dispositions', async () => {
    const r = await run(tools.recallVerdicts, { query: 'similar case' });
    expect(r.recalled[0]).toHaveProperty('disposition');
    expect(r.recalled[0]).toHaveProperty('transaction_id');
  });
});
