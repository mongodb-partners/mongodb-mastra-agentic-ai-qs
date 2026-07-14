import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { RetrievalService } from '../../retrieval/service';

/**
 * The agent's grounding tools over one Atlas cluster. Each wraps a single-collection
 * aggregation on `transactions`:
 *   - search_precedent : $vectorSearch (semantic, decided precedent)
 *   - search_text      : $search (BM25 exact names/codes)
 *   - hybrid_search    : $rankFusion (server-side RRF of the two)
 *   - trace_funds      : $graphLookup (fraud-ring / circular-flow signals)
 *   - recall_verdicts  : $vectorSearch recall of prior decided cases (precedent recall)
 * Built as a factory so the RetrievalService (holding the Db + embedder) is injected.
 */
export function buildRetrievalTools(svc: RetrievalService) {
  const idInput = z.object({
    query: z.string().describe('the case narrative or a focused search phrase'),
    k: z.number().int().positive().max(20).optional().describe('how many results (default 5)'),
  });

  const searchPrecedent = createTool({
    id: 'search_precedent',
    description: 'Semantic search for similar ALREADY-DECIDED cases (vector search). Use to find precedent for the case under review.',
    inputSchema: idInput,
    execute: async (input: any) => ({ results: await svc.vector(input.query, input.k ?? 5) }),
  });

  const searchText = createTool({
    id: 'search_text',
    description: 'Full-text keyword search over transaction narratives and party names. Use for exact names, codes, and phrases embeddings blur.',
    inputSchema: idInput,
    execute: async (input: any) => ({ results: await svc.lexical(input.query, input.k ?? 5) }),
  });

  const hybridSearch = createTool({
    id: 'hybrid_search',
    description: 'Hybrid vector + full-text search fused server-side (reciprocal rank fusion). The best default for finding relevant precedent.',
    inputSchema: idInput,
    execute: async (input: any) => ({ results: await svc.hybrid(input.query, input.k ?? 5) }),
  });

  const traceFunds = createTool({
    id: 'trace_funds',
    description: "Trace the sender account's transfer network for circular-flow / mule / layering patterns (graph traversal).",
    inputSchema: z.object({
      account_id: z.string().describe("the sender's account_number to trace from"),
      max_depth: z.number().int().positive().max(6).optional(),
    }),
    execute: async (input: any) => svc.traceFunds(input.account_id, input.max_depth ?? 3),
  });

  const recallVerdicts = createTool({
    id: 'recall_verdicts',
    description: 'Recall prior decided cases that resemble this one and cite how they were resolved (precedent recall).',
    inputSchema: idInput,
    execute: async (input: any) => {
      const hits = await svc.vector(input.query, input.k ?? 3);
      return {
        recalled: hits.map(h => ({
          transaction_id: h.transaction_id,
          disposition: h.status,
          lane: h.lane,
          summary: h.text,
        })),
      };
    },
  });

  return { searchPrecedent, searchText, hybridSearch, traceFunds, recallVerdicts };
}
