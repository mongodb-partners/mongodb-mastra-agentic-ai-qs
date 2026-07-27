import {
  TRANSACTIONS_VECTOR_INDEX, TRANSACTIONS_SEARCH_INDEX, DECIDED_STATUSES,
} from '../mastra/schemas/transactions';

/** Fields projected out of retrieval hits (embedding excluded — large + not needed downstream). */
export const PROJECT_FIELDS = ['transaction_id', 'text', 'amount', 'currency', 'sender', 'recipient', 'status', 'lane'] as const;

/**
 * Minimum `numCandidates` for every `$vectorSearch` here — the HNSW shortlist floor.
 *
 * This used to be 50, which at the app's k=5 meant *every* query ran at 50. That is below the
 * useful floor of a binary-quantized index (see `BINARY_QUANTIZATION_MIN_DOCS` in
 * `src/data/provision-transactions.ts`): binary walks the graph on 1-bit vectors and then rescores
 * the shortlist against full-fidelity ones, so too small a shortlist leaves nothing worth
 * rescoring. Measured at 1M, binary at cand 100 has a **p99 of 1.9 s**; at cand 200 it is 28.5 ms.
 *
 * 400 is deliberately one value for every corpus size rather than a scale-aware knob, because it
 * measured best or tied-best at both ends of the range this app is built for:
 *
 * | corpus | index | cand 400 recall@10 | cand 400 p50 | vs cand 50 |
 * |---|---|---|---|---|
 * | 1M | binary | 0.9830 | 34.4 ms | float32@50 was unmeasurably slow; @400 was 69.7 ms |
 * | 12k | float32 | 1.0000 | 7.6 ms | 1.0000 @ 6.5 ms — costs ~1.1 ms |
 *
 * So a small corpus pays ~1 ms against a ~1.9 ms transport floor and an LLM-bound investigation
 * measured in seconds, while a large one gets a shortlist its index can actually use. Raising this
 * is cheap; lowering it below 200 re-opens the 1.9 s tail.
 */
export const VECTOR_CANDIDATE_FLOOR = 400;

function projectStage(withScore = false): Record<string, unknown> {
  const proj: Record<string, unknown> = { _id: 0 };
  for (const f of PROJECT_FIELDS) proj[f] = 1;
  if (withScore) proj.score = { $meta: 'score' };
  return { $project: proj };
}

/** $vectorSearch over decided precedents (filtered to DECIDED_STATUSES). */
export function buildVectorPipeline(
  qvec: number[], opts: { limit: number; candidates?: number } ,
): Record<string, unknown>[] {
  const { limit } = opts;
  return [
    {
      $vectorSearch: {
        index: TRANSACTIONS_VECTOR_INDEX,
        path: 'embedding',
        queryVector: qvec,
        // An explicit `candidates` is honoured as given (benchmarks sweep it deliberately);
        // only the default is floored. See VECTOR_CANDIDATE_FLOOR.
        numCandidates: opts.candidates ?? Math.max(VECTOR_CANDIDATE_FLOOR, limit * 10),
        limit,
        filter: { status: { $in: [...DECIDED_STATUSES] } },
      },
    },
    projectStage(),
  ];
}

/** $search (BM25) full-text over the narrative + party names. */
export function buildLexicalPipeline(query: string, opts: { limit: number }): Record<string, unknown>[] {
  return [
    { $search: { index: TRANSACTIONS_SEARCH_INDEX, text: { query, path: ['text', 'sender.name', 'recipient.name'] } } },
    { $limit: opts.limit },
    projectStage(),
  ];
}

/**
 * Hybrid via native $rankFusion (MongoDB 8.0+): runs the vector and lexical pipelines
 * server-side and fuses them by reciprocal rank. No client-side merge.
 */
export function buildRankFusionPipeline(
  qvec: number[], query: string, opts: { k: number },
): Record<string, unknown>[] {
  const { k } = opts;
  const candidates = Math.max(VECTOR_CANDIDATE_FLOOR, k * 10);
  const perBranch = Math.max(k * 4, 20);
  return [
    {
      $rankFusion: {
        input: {
          pipelines: {
            vector: [
              {
                $vectorSearch: {
                  index: TRANSACTIONS_VECTOR_INDEX,
                  path: 'embedding',
                  queryVector: qvec,
                  numCandidates: candidates,
                  limit: perBranch,
                  filter: { status: { $in: [...DECIDED_STATUSES] } },
                },
              },
            ],
            lexical: [
              { $search: { index: TRANSACTIONS_SEARCH_INDEX, text: { query, path: ['text', 'sender.name', 'recipient.name'] } } },
              // Match the vector branch: only ALREADY-DECIDED cases are eligible precedent, so a
              // pending/live case can't be fused in as its own "precedent" (review finding #6).
              { $match: { status: { $in: [...DECIDED_STATUSES] } } },
              { $limit: perBranch },
            ],
          },
        },
      },
    },
    { $limit: k },
    projectStage(true),
  ];
}

/**
 * $graphLookup following sender.account_number -> recipient.account_number to surface a network.
 *
 * The $limit and the $project are both load-bearing at scale, for different reasons:
 *
 * - `$limit: 1` bounds the ANCHOR. The seed account has ~100 transactions and each one
 *   otherwise seeds its own full closure, all of them identical. Measured 185ms -> 51ms.
 *   It does NOT help with the size cap: a chain that overflows fails byte-identically.
 *
 * - The `$project` is what keeps the chain under the 16MB BSON limit. The optimizer pushes
 *   it into $graphLookup, so the chain is never materialized at full document width —
 *   13,736 B/edge (the 1024-float embedding dominates) drops to 115 B/edge. Verified
 *   against a chain that is 40.7MB unprojected: it fails without this and succeeds with it.
 *   The 16MB limit is a protocol constraint; no Atlas tier raises it.
 *
 * Keep the projected field list in sync with what consumers read — summarizeRing() below
 * and RetrievalService.traceFundsGraph() both use sender/recipient account numbers plus
 * amount, and the UI renders `depth`. Dropping a field here silently empties part of a ring.
 *
 * NOTE this is still not sufficient on its own at 1M documents: a dense (uniform-random)
 * account topology makes the depth-3 closure reach every account, which is ~102MB even
 * projected. The corpus topology has to be clustered too — see COMMUNITY_SIZE / BRIDGE_RATE
 * in synthetic-corpus.ts, which bring the 1M worst case to 4.39MB.
 */
export function buildGraphPipeline(
  accountId: string, opts: { maxDepth?: number; collection?: string } = {},
): Record<string, unknown>[] {
  const maxDepth = opts.maxDepth ?? 3;
  const collection = opts.collection ?? 'transactions';
  return [
    { $match: { 'sender.account_number': accountId } },
    { $limit: 1 },
    {
      $graphLookup: {
        from: collection,
        startWith: '$recipient.account_number',
        connectFromField: 'recipient.account_number',
        connectToField: 'sender.account_number',
        as: 'chain',
        maxDepth,
        depthField: 'depth',
      },
    },
    {
      $project: {
        _id: 0,
        'chain.sender.account_number': 1,
        'chain.recipient.account_number': 1,
        'chain.amount': 1,
        'chain.depth': 1,
      },
    },
  ];
}

export interface RingSummary {
  network_size: number;
  unique_accounts: number;
  circular_flow: boolean;
  layering: boolean;
  suspicious_patterns: boolean;
}

/** Turn a $graphLookup chain into fraud-ring signals: circular flow back to the seed account,
 *  layering (many small transfers), and overall network size. */
export function summarizeRing(graphDoc: { chain?: any[] }, seedAccount: string): RingSummary {
  const chain = graphDoc.chain ?? [];
  const accounts = new Set<string>();
  let smallTransfers = 0;
  let circularFlow = false;
  for (const edge of chain) {
    const sender = edge?.sender?.account_number as string | undefined;
    const recipient = edge?.recipient?.account_number as string | undefined;
    if (sender) accounts.add(sender);
    if (recipient) accounts.add(recipient);
    if (recipient === seedAccount) circularFlow = true;
    if (Number(edge?.amount ?? 0) < 1000) smallTransfers++;
  }
  const networkSize = chain.length;
  const layering = smallTransfers >= 3;
  return {
    network_size: networkSize,
    unique_accounts: accounts.size,
    circular_flow: circularFlow,
    layering,
    suspicious_patterns: circularFlow || layering || networkSize >= 3,
  };
}
