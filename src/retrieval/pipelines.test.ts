import { describe, it, expect } from 'vitest';
import {
  buildVectorPipeline, buildLexicalPipeline, buildRankFusionPipeline, buildGraphPipeline, summarizeRing,
} from './pipelines';
import { TRANSACTIONS_VECTOR_INDEX, TRANSACTIONS_SEARCH_INDEX } from '../mastra/schemas/transactions';

const qvec = Array.from({ length: 1024 }, () => 0.01);

describe('retrieval pipeline builders', () => {
  it('vector pipeline filters to decided statuses and uses the vector index', () => {
    const p = buildVectorPipeline(qvec, { limit: 3 }) as any[];
    expect(p[0].$vectorSearch.index).toBe(TRANSACTIONS_VECTOR_INDEX);
    expect(p[0].$vectorSearch.filter.status.$in).toEqual(['approved', 'rejected', 'escalated']);
    expect(p[0].$vectorSearch.limit).toBe(3);
  });

  it('lexical pipeline searches text + party names on the search index', () => {
    const p = buildLexicalPipeline('cash deposit', { limit: 5 }) as any[];
    expect(p[0].$search.index).toBe(TRANSACTIONS_SEARCH_INDEX);
    expect(p[0].$search.text.path).toContain('sender.name');
    expect(p[1].$limit).toBe(5);
  });

  it('rank-fusion pipeline fuses a vector and lexical branch', () => {
    const p = buildRankFusionPipeline(qvec, 'structuring', { k: 3 }) as any[];
    const pipelines = p[0].$rankFusion.input.pipelines;
    expect(Object.keys(pipelines)).toEqual(['vector', 'lexical']);
    expect(pipelines.vector[0].$vectorSearch.index).toBe(TRANSACTIONS_VECTOR_INDEX);
    expect(pipelines.lexical[0].$search.index).toBe(TRANSACTIONS_SEARCH_INDEX);
  });

  it('BOTH rank-fusion branches filter to decided statuses (finding #6 — no pending precedent)', () => {
    const p = buildRankFusionPipeline(qvec, 'structuring', { k: 3 }) as any[];
    const pipelines = p[0].$rankFusion.input.pipelines;
    expect(pipelines.vector[0].$vectorSearch.filter.status.$in).toEqual(['approved', 'rejected', 'escalated']);
    const lexMatch = pipelines.lexical.find((s: any) => s.$match);
    expect(lexMatch.$match.status.$in).toEqual(['approved', 'rejected', 'escalated']);
  });

  it('graph pipeline follows sender -> recipient links', () => {
    const p = buildGraphPipeline('ACC-RING-A') as any[];
    expect(p[0].$match['sender.account_number']).toBe('ACC-RING-A');
    expect(p[1].$graphLookup.connectFromField).toBe('recipient.account_number');
    expect(p[1].$graphLookup.connectToField).toBe('sender.account_number');
    expect(p[1].$graphLookup.maxDepth).toBe(3);
  });
});

describe('summarizeRing', () => {
  it('detects circular flow back to the seed account', () => {
    const chain = [
      { sender: { account_number: 'A' }, recipient: { account_number: 'B' }, amount: 920 },
      { sender: { account_number: 'B' }, recipient: { account_number: 'C' }, amount: 880 },
      { sender: { account_number: 'C' }, recipient: { account_number: 'A' }, amount: 850 },
    ];
    const r = summarizeRing({ chain }, 'A');
    expect(r.circular_flow).toBe(true);
    expect(r.layering).toBe(true); // 3 small (<1000) transfers
    expect(r.network_size).toBe(3);
    expect(r.suspicious_patterns).toBe(true);
  });

  it('is quiet on a lone large transfer', () => {
    const chain = [{ sender: { account_number: 'X' }, recipient: { account_number: 'Y' }, amount: 75000 }];
    const r = summarizeRing({ chain }, 'X');
    expect(r.circular_flow).toBe(false);
    expect(r.layering).toBe(false);
    expect(r.suspicious_patterns).toBe(false);
  });

  it('handles an empty chain', () => {
    const r = summarizeRing({ chain: [] }, 'A');
    expect(r.network_size).toBe(0);
    expect(r.suspicious_patterns).toBe(false);
  });
});
