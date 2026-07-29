import { describe, it, expect } from 'vitest';
import { Decimal128 } from 'mongodb';
import {
  buildVectorPipeline, buildLexicalPipeline, buildRankFusionPipeline, buildGraphPipeline, summarizeRing,
  VECTOR_CANDIDATE_FLOOR,
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

  it('floors numCandidates on BOTH the vector pipeline and the fusion branch', () => {
    // The app runs k=5/limit=5, where `limit * 10` is 50 — and 50 is below the useful floor of a
    // binary-quantized index, whose rescore step needs a shortlist worth rescoring. Measured at
    // 1M: binary at cand 100 has a p99 of 1.9s; at cand 200+ the tail is flat.
    expect(VECTOR_CANDIDATE_FLOOR).toBeGreaterThanOrEqual(200);
    const v = buildVectorPipeline(qvec, { limit: 5 }) as any[];
    expect(v[0].$vectorSearch.numCandidates).toBe(VECTOR_CANDIDATE_FLOOR);
    const f = buildRankFusionPipeline(qvec, 'structuring', { k: 5 }) as any[];
    expect(f[0].$rankFusion.input.pipelines.vector[0].$vectorSearch.numCandidates)
      .toBe(VECTOR_CANDIDATE_FLOOR);
  });

  it('still scales numCandidates above the floor for a large limit', () => {
    const p = buildVectorPipeline(qvec, { limit: 200 }) as any[];
    expect(p[0].$vectorSearch.numCandidates).toBe(2000);
  });

  it('honours an explicit candidates value below the floor, for benchmark sweeps', () => {
    // The floor is a default, not a clamp: benchmark probes sweep numCandidates deliberately
    // (that sweep is how the floor was chosen), so overriding it must reach Atlas unchanged.
    const p = buildVectorPipeline(qvec, { limit: 5, candidates: 50 }) as any[];
    expect(p[0].$vectorSearch.numCandidates).toBe(50);
  });

  it('graph pipeline follows sender -> recipient links', () => {
    const p = buildGraphPipeline('ACC-RING-A') as any[];
    expect(p[0].$match['sender.account_number']).toBe('ACC-RING-A');
    expect(p[2].$graphLookup.connectFromField).toBe('recipient.account_number');
    expect(p[2].$graphLookup.connectToField).toBe('sender.account_number');
    expect(p[2].$graphLookup.maxDepth).toBe(3);
  });

  it('bounds the anchor to one document and projects the chain down to consumed fields', () => {
    const p = buildGraphPipeline('ACC-1', { maxDepth: 3 }) as any[];
    // $limit:1 sits AFTER the anchor $match and BEFORE $graphLookup: the anchor account has
    // ~100 transactions and every one of them otherwise seeds its own full traversal.
    // Measured on the live corpus: 185ms -> 51ms. This is latency ONLY — it gives zero
    // relief on the 16MB BSON cap (a chain that overflows fails byte-identically with it).
    expect(p.map(s => Object.keys(s)[0])).toEqual(['$match', '$limit', '$graphLookup', '$project']);
    expect(p[1]).toEqual({ $limit: 1 });
    // The chain projection is what clears the 16MB cap: the optimizer pushes it into
    // $graphLookup so the chain is never materialized at full document width (verified
    // against a chain that is 40.7MB unprojected and fails without it). 13,736 -> 115 B/edge.
    // Keep exactly the fields summarizeRing() and traceFundsGraph() read, nothing else.
    expect(p[3]).toEqual({
      $project: {
        _id: 0,
        'chain.sender.account_number': 1,
        'chain.recipient.account_number': 1,
        'chain.amount': 1,
        'chain.depth': 1,
      },
    });
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

  it('defaults trace_status to complete, so a caller holding a chain asserts it looked', () => {
    expect(summarizeRing({ chain: [] }, 'A').trace_status).toBe('complete');
  });

  it('carries the caller\'s trace_status through', () => {
    // The distinction the summary alone cannot make: all three of these produce network_size 0 and
    // suspicious_patterns false, and only `trace_status` says whether that is a finding.
    expect(summarizeRing({ chain: [] }, 'A', 'account_not_found').trace_status).toBe('account_not_found');
    expect(summarizeRing({ chain: [] }, 'A', 'incomplete').trace_status).toBe('incomplete');
  });

  it('still reports a ring found in a chain that is only PARTIAL', () => {
    // An `incomplete` trace ran out of memory partway, but what it did walk is real. Suppressing a
    // true positive because the traversal was cut short would lose the finding entirely.
    const chain = [
      { sender: { account_number: 'A' }, recipient: { account_number: 'B' }, amount: 920 },
      { sender: { account_number: 'B' }, recipient: { account_number: 'A' }, amount: 880 },
    ];
    const r = summarizeRing({ chain }, 'A', 'incomplete');
    expect(r.circular_flow).toBe(true);
    expect(r.suspicious_patterns).toBe(true);
    expect(r.trace_status).toBe('incomplete');
  });
});

describe('summarizeRing with Decimal128 edge amounts', () => {
  it('detects layering when the small transfers are Decimal128', () => {
    // Regression guard, not a change: Number() coerces a Decimal128 via toString(), so the
    // existing `Number(edge?.amount ?? 0) < 1000` is already correct. This test exists so a later
    // refactor to a bare `edge.amount < 1000` — which is false for every Decimal128 — is caught.
    const chain = [
      { sender: { account_number: 'A' }, recipient: { account_number: 'B' }, amount: Decimal128.fromString('920.00') },
      { sender: { account_number: 'B' }, recipient: { account_number: 'C' }, amount: Decimal128.fromString('880.00') },
      { sender: { account_number: 'C' }, recipient: { account_number: 'A' }, amount: Decimal128.fromString('850.00') },
    ];
    const r = summarizeRing({ chain }, 'A');
    expect(r.layering).toBe(true);
    expect(r.circular_flow).toBe(true);
    expect(r.suspicious_patterns).toBe(true);
  });

  it('does not call a large Decimal128 transfer layering', () => {
    const chain = [{ sender: { account_number: 'X' }, recipient: { account_number: 'Y' }, amount: Decimal128.fromString('75000.00') }];
    expect(summarizeRing({ chain }, 'X').layering).toBe(false);
  });

  it('agrees with the plain-number result edge for edge', () => {
    const mk = (amt: number | Decimal128) => ([
      { sender: { account_number: 'A' }, recipient: { account_number: 'B' }, amount: amt },
    ]);
    for (const v of [1, 999, 1000, 1001, 75000]) {
      expect(summarizeRing({ chain: mk(Decimal128.fromString(`${v}.00`)) }, 'A'))
        .toEqual(summarizeRing({ chain: mk(v) }, 'A'));
    }
  });
});
