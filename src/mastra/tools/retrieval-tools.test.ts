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
  traceFunds: async () => ({ network_size: 3, unique_accounts: 3, circular_flow: true, layering: true, suspicious_patterns: true }),
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
  });

  it('recall_verdicts cites prior dispositions', async () => {
    const r = await run(tools.recallVerdicts, { query: 'similar case' });
    expect(r.recalled[0]).toHaveProperty('disposition');
    expect(r.recalled[0]).toHaveProperty('transaction_id');
  });
});
