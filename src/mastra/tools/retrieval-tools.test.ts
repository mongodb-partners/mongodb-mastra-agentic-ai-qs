import { describe, it, expect } from 'vitest';
import { RequestContext } from '@mastra/core/di';
import { buildRetrievalTools, SUBJECT_ACCOUNT_KEY } from './retrieval-tools';

// A stub RetrievalService with the five methods the tools call.
const stub = {
  vector: async (_q: string, k = 5) => Array.from({ length: k }, (_, i) => ({
    transaction_id: `v${i}`, text: 'narrative', amount: 1, currency: 'USD',
    sender: { name: 's', account_number: 'A' }, recipient: { name: 'r', account_number: 'B' },
    status: 'rejected', lane: 'structuring',
  })),
  lexical: async () => [{ transaction_id: 'lx', text: 't', amount: 1, currency: 'USD', sender: { name: 's', account_number: 'A' }, recipient: { name: 'r', account_number: 'B' }, status: 'approved', lane: 'clean_approve' }],
  hybrid: async () => [{ transaction_id: 'hy', text: 't', amount: 1, currency: 'USD', sender: { name: 's', account_number: 'A' }, recipient: { name: 'r', account_number: 'B' }, status: 'escalated', lane: 'ring' }],
  // Echoes the account it was asked to trace, so a test can assert WHICH account was traced —
  // the defaulting behaviour is otherwise invisible.
  traceFunds: async (acct: string, depth?: number) => ({
    network_size: 3, unique_accounts: 3, circular_flow: true, layering: true,
    suspicious_patterns: true, trace_status: 'complete', depth_used: depth, traced: acct,
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

  describe('trace_funds defaults to the account under review', () => {
    // WHY: with account_id required and the account absent from the narrative, every model tested
    // fabricated one, and a fabricated account traced nothing that then read as clean. Defaulting
    // server-side makes the common path unfakeable.
    /** Run a tool with a bound case account, the way the agent does. */
    const withAccount = (account: string) => {
      const rc = new RequestContext();
      rc.set(SUBJECT_ACCOUNT_KEY, account);
      return { requestContext: rc };
    };

    it('traces the requestContext account when account_id is omitted', async () => {
      const r = await (tools.traceFunds as any).execute({}, withAccount('ACC-RING-A'));
      expect(r.traced).toBe('ACC-RING-A');
      expect(r.account_traced).toBe('ACC-RING-A');
    });

    it('still honours an explicit account_id, for tracing a second-hop account', async () => {
      const r = await (tools.traceFunds as any).execute({ account_id: 'ACC-OTHER' }, withAccount('ACC-RING-A'));
      expect(r.traced).toBe('ACC-OTHER');
    });

    it('reports not-found instead of tracing an empty account when there is no context', async () => {
      // A direct execute() caller with no case bound. Tracing '' would match nothing and read clean.
      const r = await run(tools.traceFunds, {});
      expect(r.trace_status).toBe('account_not_found');
      expect(r.suspicious_patterns).toBe(false);
      expect(r.error).toMatch(/no account to trace/);
      expect(r.traced).toBeUndefined();
    });
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
