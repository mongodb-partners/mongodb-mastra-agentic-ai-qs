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

/**
 * Did this trace actually observe the account's network?
 *
 * Three outcomes, and only one of them is a finding. An empty chain is produced by all three:
 *
 *   - `complete`          the seed account exists and its closure was walked. An empty chain here
 *                         is real evidence: this account transfers to nobody.
 *   - `account_not_found` no transaction in the corpus has this account as its sender, so there was
 *                         nothing to walk. Produced by a typo, a stale id, or — measured — a model
 *                         inventing one ('<UNKNOWN>', 'Quartz Trading') when it was never told the
 *                         account number.
 *   - `incomplete`        the traversal hit the 100 MB $graphLookup ceiling (code 40099) partway.
 *                         The account is real and MAY be ringed; we simply could not finish looking.
 *
 * WHY THIS IS A SEPARATE FIELD rather than folded into `suspicious_patterns`. The two questions are
 * independent: "what did we see" and "did we get to look". Collapsing them either way produces a
 * false statement — reporting `suspicious_patterns: true` for an account we never found makes the
 * console announce "Ring detected · 0 hops", and leaving the caller with only
 * `suspicious_patterns: false` makes "we could not check" indistinguishable from "this account is
 * clean". In a fraud trace those are opposite conclusions, and the second is the dangerous one: it
 * is an absence of evidence presented as evidence of absence, and it reached a hash-sealed audit
 * record. So `suspicious_patterns` keeps meaning exactly what it says (patterns actually observed),
 * and callers that need to know whether the observation is trustworthy read this.
 */
export type TraceStatus = 'complete' | 'account_not_found' | 'incomplete';

export interface RingSummary {
  network_size: number;
  unique_accounts: number;
  circular_flow: boolean;
  layering: boolean;
  suspicious_patterns: boolean;
  /** Whether the traversal actually observed this account's network. See TraceStatus. */
  trace_status: TraceStatus;
}

/**
 * Turn a $graphLookup chain into fraud-ring signals: circular flow back to the seed account,
 * layering (many small transfers), and overall network size.
 *
 * `status` defaults to 'complete' because that is what a caller handing over a chain it already
 * holds is asserting — it has a document, so the seed account existed. Only RetrievalService can
 * distinguish the other two cases (they are the shapes it gets back INSTEAD of a document), so it
 * passes the status explicitly.
 */
export function summarizeRing(
  graphDoc: { chain?: any[] }, seedAccount: string, status: TraceStatus = 'complete',
): RingSummary {
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
    // Deliberately unqualified by `status`: this reports what the chain SHOWS. A trace that found
    // nothing to look at cannot show patterns, so this is already false in those cases — and a
    // partial (40099) chain can legitimately show a ring in the part that did get walked, which is
    // a true positive worth keeping. `trace_status` is what tells a caller how much to trust it.
    suspicious_patterns: circularFlow || layering || networkSize >= 3,
    trace_status: status,
  };
}
