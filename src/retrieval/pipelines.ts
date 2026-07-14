import {
  TRANSACTIONS_VECTOR_INDEX, TRANSACTIONS_SEARCH_INDEX, DECIDED_STATUSES,
} from '../mastra/schemas/transactions';

/** Fields projected out of retrieval hits (embedding excluded — large + not needed downstream). */
export const PROJECT_FIELDS = ['transaction_id', 'text', 'amount', 'currency', 'sender', 'recipient', 'status', 'lane'] as const;

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
        numCandidates: opts.candidates ?? Math.max(50, limit * 10),
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
  const candidates = Math.max(50, k * 10);
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

/** $graphLookup following sender.account_number -> recipient.account_number to surface a network. */
export function buildGraphPipeline(
  accountId: string, opts: { maxDepth?: number; collection?: string } = {},
): Record<string, unknown>[] {
  const maxDepth = opts.maxDepth ?? 3;
  const collection = opts.collection ?? 'transactions';
  return [
    { $match: { 'sender.account_number': accountId } },
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
