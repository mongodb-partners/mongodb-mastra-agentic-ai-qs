import type { Db } from 'mongodb';
import {
  buildVectorPipeline, buildLexicalPipeline, buildRankFusionPipeline, buildGraphPipeline,
  summarizeRing, type RingSummary,
} from './pipelines';
import { TRANSACTIONS_COLLECTION } from '../mastra/schemas/transactions';
import { logger } from '../observability/logger';
import type { MoneyLike } from '../money';

export type EmbedQuery = (text: string) => Promise<number[]>;

export interface RetrievalHit {
  transaction_id: string;
  text: string;
  /** Decimal128 as read from the collection; a number for any document written pre-migration. */
  amount: MoneyLike;
  currency: string;
  sender: { name: string; account_number: string };
  recipient: { name: string; account_number: string };
  status: string;
  lane: string;
  score?: number;
}

/**
 * The retrieval surface the agent's tools call. All methods run a single aggregation on the
 * `transactions` collection — one collection, one engine (vector, lexical, hybrid, graph).
 */
export class RetrievalService {
  constructor(private db: Db, private embedQuery: EmbedQuery) {}

  private col() { return this.db.collection(TRANSACTIONS_COLLECTION); }

  /** Semantic precedent (decided cases only). */
  async vector(query: string, limit = 5): Promise<RetrievalHit[]> {
    const qvec = await this.embedQuery(query);
    return this.col().aggregate<RetrievalHit>(buildVectorPipeline(qvec, { limit })).toArray();
  }

  /** Full-text (BM25) over narrative + party names. */
  async lexical(query: string, limit = 5): Promise<RetrievalHit[]> {
    return this.col().aggregate<RetrievalHit>(buildLexicalPipeline(query, { limit })).toArray();
  }

  /** Hybrid (server-side reciprocal rank fusion). */
  async hybrid(query: string, k = 5): Promise<RetrievalHit[]> {
    const qvec = await this.embedQuery(query);
    return this.col().aggregate<RetrievalHit>(buildRankFusionPipeline(qvec, query, { k })).toArray();
  }

  /**
   * Run the traversal, tolerating the one failure mode a wide account produces at scale.
   *
   * `$graphLookup` buffers its visited set in memory with a hard **100 MB** ceiling and, unlike a
   * blocking sort, does NOT spill to disk — `allowDiskUse` has no effect on it. So a traversal from
   * a densely-connected account fails outright with code 40099 ("$graphLookup reached maximum
   * memory consumption"), which is a DIFFERENT limit from the 16 MB reply cap that
   * `buildGraphPipeline`'s `$project` addresses: the projected output would fit fine, the
   * intermediate visited set is what overflows.
   *
   * Measured at 1M documents, sampling arbitrary corpus accounts at the depths the tool allows:
   * depth 3 failed ~1 in 300, depth 4 15%, depth 5 40%, depth 6 50%. The curated cases the app
   * itself traces are unaffected (0-4 edges, ~1.7 ms) — the exposure is an agent passing an account
   * it saw in a precedent hit, which every retrieval result exposes via `sender.account_number`.
   *
   * A trace that cannot complete is missing evidence, not a failed investigation: the caller still
   * has precedents, the amount and the lane. Returning an empty chain degrades the ring signal to
   * "nothing found" and lets the case reach a decision, where propagating would abort it before
   * governance, the audit write and the human-review gate ever run.
   */
  private async graphChain(accountId: string, maxDepth: number): Promise<{ chain?: any[] }> {
    try {
      const docs = await this.col().aggregate(buildGraphPipeline(accountId, { maxDepth })).toArray();
      return (docs[0] ?? { chain: [] }) as { chain?: any[] };
    } catch (err) {
      // Only the memory ceiling is tolerated. Anything else (auth, a malformed pipeline, a dropped
      // connection) is a real fault and must not be silently reported as a clean fund-trace.
      if ((err as { code?: number })?.code !== 40099) throw err;
      logger.warn('fund-trace exceeded the $graphLookup memory limit; treating as no ring found', {
        account: accountId, maxDepth,
      });
      return { chain: [] };
    }
  }

  /** Trace the sender's transfer network and summarize fraud-ring signals. */
  async traceFunds(accountId: string, maxDepth = 3): Promise<RingSummary> {
    return summarizeRing(await this.graphChain(accountId, maxDepth), accountId);
  }

  /** Trace + return the raw edges (for the ring visualization) alongside the summary. */
  async traceFundsGraph(accountId: string, maxDepth = 3): Promise<RingSummary & { edges: { from: string; to: string; amount: number }[] }> {
    const doc = await this.graphChain(accountId, maxDepth);
    const summary = summarizeRing(doc as any, accountId);
    const edges = ((doc as any).chain ?? []).map((e: any) => ({
      from: e?.sender?.account_number ?? '?',
      to: e?.recipient?.account_number ?? '?',
      // A plain number deliberately, unlike RetrievalHit.amount: these edges go to the UI as JSON
      // and to ringSvg for arithmetic. `Number()` handles both representations — it coerces a
      // Decimal128 through toString() — so this needs no money helper.
      amount: Number(e?.amount ?? 0),
    }));
    return { ...summary, edges };
  }
}
