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

  /**
   * Ceiling on the traversal depth the AGENT may request.
   *
   * Was 6. `$graphLookup` holds its visited set in memory under a hard 100 MB limit that it cannot
   * spill to disk, and the closure widens fast: measured against 1M documents on arbitrary corpus
   * accounts, depth 4 failed 15% of traversals with code 40099, depth 5 40%, and depth 6 50% —
   * while the successful ones ran 1.2 s at p50 and 3.4 s at p99. Depth 3 is the pipeline default,
   * is what `run-engine.ts` calls for its own trace, and is what the corpus topology
   * (`COMMUNITY_SIZE`) was sized to keep bounded, so nothing the app needs lives above it.
   *
   * The service degrades a 40099 to an empty chain rather than failing the case
   * (`RetrievalService.graphChain`), so this cap is about not spending seconds on a traversal that
   * usually returns nothing — not about correctness. Lowering the schema bound also tells the model
   * the real limit: declaring 6 while quietly clamping to 3 would discard what it asked for without
   * saying so.
   */
  const MAX_TRACE_DEPTH = 3;

  const traceFunds = createTool({
    id: 'trace_funds',
    description: "Trace the sender account's transfer network for circular-flow / mule / layering patterns (graph traversal).",
    inputSchema: z.object({
      account_id: z.string().describe("the sender's account_number to trace from"),
      max_depth: z.number().int().positive().max(MAX_TRACE_DEPTH).optional()
        .describe(`how many hops to follow (1-${MAX_TRACE_DEPTH}, default ${MAX_TRACE_DEPTH})`),
    }),
    // The zod `max` is the real enforcement — Mastra validates inputSchema before calling execute,
    // so an over-deep request returns a corrective error to the model and never runs. The clamp is
    // belt-and-braces for any caller that invokes execute directly (tests, a future non-agent
    // path), where nothing would otherwise bound the depth.
    execute: async (input: any) => svc.traceFunds(
      input.account_id, Math.min(input.max_depth ?? MAX_TRACE_DEPTH, MAX_TRACE_DEPTH),
    ),
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
