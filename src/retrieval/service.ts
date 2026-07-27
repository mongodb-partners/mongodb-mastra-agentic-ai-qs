import type { Db } from 'mongodb';
import {
  buildVectorPipeline, buildLexicalPipeline, buildRankFusionPipeline, buildGraphPipeline,
  summarizeRing, type RingSummary,
} from './pipelines';
import { TRANSACTIONS_COLLECTION } from '../mastra/schemas/transactions';
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

  /** Trace the sender's transfer network and summarize fraud-ring signals. */
  async traceFunds(accountId: string, maxDepth = 3): Promise<RingSummary> {
    const docs = await this.col().aggregate(buildGraphPipeline(accountId, { maxDepth })).toArray();
    return summarizeRing(docs[0] ?? { chain: [] }, accountId);
  }

  /** Trace + return the raw edges (for the ring visualization) alongside the summary. */
  async traceFundsGraph(accountId: string, maxDepth = 3): Promise<RingSummary & { edges: { from: string; to: string; amount: number }[] }> {
    const docs = await this.col().aggregate(buildGraphPipeline(accountId, { maxDepth })).toArray();
    const doc = docs[0] ?? { chain: [] };
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
