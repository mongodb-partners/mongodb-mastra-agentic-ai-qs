import type { Db } from 'mongodb';
import type { MongoDBVector } from '@mastra/mongodb';
import type { QueryResult } from '@mastra/core/vector';
import {
  buildGraphPipeline, summarizeRing, VECTOR_CANDIDATE_FLOOR,
  type RingSummary, type TraceStatus,
} from './pipelines';
import {
  TRANSACTIONS_COLLECTION, TRANSACTIONS_SEARCH_INDEX, DECIDED_STATUSES,
} from '../mastra/schemas/transactions';
import { TRANSACTIONS_INDEX } from './vector-store';
import { logger } from '../observability/logger';
import { toMoney, type MoneyLike } from '../money';

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

/** The precedent filter, as one expression both the vector and hybrid reads pass to the store. */
const DECIDED_ONLY = { status: { $in: [...DECIDED_STATUSES] } };

/** The BM25 paths, matching the static mapping `provisionTransactionSearchIndex` declares. */
const LEXICAL_PATHS = ['text', 'sender.name', 'recipient.name'];

/**
 * Shape one `@mastra/mongodb` result into a `RetrievalHit`.
 *
 * FIELD-BY-FIELD, NOT A SPREAD, and that is load-bearing for two separate reasons.
 *
 * 1. In `metadataMode: 'document'` the library projects `metadata: '$$ROOT'`, so `metadata` is the
 *    whole source transaction — including its `_id`. These hits are persisted: `run-engine` puts the
 *    hybrid results straight into `case_analysis.precedents` through the app's own driver. Naming
 *    the fields drops `_id` (and anything else the corpus grows later) instead of carrying it into a
 *    write, which matters because of the next point.
 *
 * 2. THE TWO DRIVERS DO NOT SHARE BSON CLASSES. `@mastra/mongodb` bundles mongodb 7 (bson 7) while
 *    the app runs mongodb 6 (bson 6), so every BSON value that comes back here — `Decimal128`,
 *    `ObjectId`, `Binary` — is an instance of the *other* copy's class. bson 6 refuses to serialize
 *    those: `serialize({amount: <bson7 Decimal128>})` throws
 *    `BSONVersionError: Unsupported BSON version, bson types must be from bson 6.x.x` (verified both
 *    ways against the installed trees). So a foreign value reaching `replaceOne` does not degrade,
 *    it throws, and `run-engine`'s per-case catch turns the whole investigation into an `error`
 *    event. `amount` is re-homed below; `_id` and `embedding` are dropped by not being named
 *    (`embedding` is already `$unset` by the library in document mode).
 *
 * `toMoney(String(...))` is the re-homing, and it is exact rather than lossy: `String()` on a
 * Decimal128 of either vintage yields the same decimal text, and `toMoney` rebuilds it through
 * `Decimal128.fromString` on the app's own bson — byte-identical to the natively-read value at the
 * money scale (measured). It also normalizes the pre-migration `number` form, so `amount` keeps
 * satisfying `MoneyLike` for every document. A value whose text is not a decimal number makes
 * `toMoney` throw, which is unreachable for well-formed BSON and is the right canary if it is not.
 */
function toHit(r: QueryResult): RetrievalHit {
  const m = (r.metadata ?? {}) as Record<string, any>;
  return {
    transaction_id: m.transaction_id,
    text: m.text,
    amount: toMoney(String(m.amount)),
    currency: m.currency,
    sender: { name: m.sender?.name, account_number: m.sender?.account_number },
    recipient: { name: m.recipient?.name, account_number: m.recipient?.account_number },
    status: m.status,
    lane: m.lane,
    score: r.score,
  };
}

/**
 * The retrieval surface the agent's tools call. One collection, one cluster, four engines.
 *
 * The three search reads run through `@mastra/mongodb`'s `MongoDBVector` against the app's
 * bring-your-own indexes (see `vector-store.ts`); the fund trace stays on the app's own `Db` and
 * `buildGraphPipeline`, because `$graphLookup` has no library equivalent. That split is why this
 * takes both handles: `store` for search, `db` for traversal.
 *
 * `store`, not `vector` — the class already has a `vector()` method.
 */
export class RetrievalService {
  constructor(private db: Db, private store: MongoDBVector, private embedQuery: EmbedQuery) {}

  private col() { return this.db.collection(TRANSACTIONS_COLLECTION); }

  /** Semantic precedent (decided cases only). */
  async vector(query: string, limit = 5): Promise<RetrievalHit[]> {
    const queryVector = await this.embedQuery(query);
    const hits = await this.store.query({
      indexName: TRANSACTIONS_INDEX,
      queryVector,
      topK: limit,
      // EXPLICIT, and the same expression `buildVectorPipeline` uses. The library's default is
      // `topK * 20`, which at this app's k=5 is 100 — and 100 is the candidate level that measured a
      // **p99 of 1.9 s** against the binary-quantized 1M index (28.5 ms at 200). Omitting this reads
      // as accepting a sensible default and is in fact a 60x tail regression that no unit test and
      // no small-corpus run can see. See VECTOR_CANDIDATE_FLOOR.
      numCandidates: Math.max(VECTOR_CANDIDATE_FLOOR, limit * 10),
      // 'document', because these are BYO operational documents with their own shape — the store
      // never wrote a managed `metadata` subdocument for them, so 'field' (the default) would
      // return `metadata: undefined` for every hit and every field below would be undefined.
      metadataMode: 'document',
      filter: DECIDED_ONLY,
    });
    return hits.map(toHit);
  }

  /** Full-text (BM25) over narrative + party names. */
  async lexical(query: string, limit = 5): Promise<RetrievalHit[]> {
    const hits = await this.store.textQuery({
      indexName: TRANSACTIONS_INDEX,
      query,
      paths: LEXICAL_PATHS,
      topK: limit,
      // EXPLICIT, so this call can never reach `resolveTextSearchIndexName`. For a BYO index that
      // helper throws unless `createSearchIndex` registered a text index — and registering one is
      // the thing to avoid: it would either collide with the app's tuned static BM25 mapping or add
      // a second, unused Lucene index over 1M documents. Naming the app's own index means the
      // library queries the mapping the app provisioned and creates nothing.
      searchIndexName: TRANSACTIONS_SEARCH_INDEX,
      metadataMode: 'document',
      // No status filter, matching `buildLexicalPipeline`: this tool exists for exact names and
      // codes, where restricting to decided cases would hide the live case an investigator is
      // looking up by name. The precedent constraint belongs to the two paths that claim precedent.
    });
    return hits.map(toHit);
  }

  /** Hybrid (server-side reciprocal rank fusion). */
  async hybrid(query: string, k = 5): Promise<RetrievalHit[]> {
    const queryVector = await this.embedQuery(query);
    const hits = await this.store.hybridQuery({
      indexName: TRANSACTIONS_INDEX,
      queryVector,
      query,
      paths: LEXICAL_PATHS,
      topK: k,
      numCandidates: Math.max(VECTOR_CANDIDATE_FLOOR, k * 10),
      textSearchIndexName: TRANSACTIONS_SEARCH_INDEX,
      metadataMode: 'document',
      // Applied to BOTH branches by the library (pushed into `$vectorSearch.filter`, and a `$match`
      // in the text pipeline), which is what `buildRankFusionPipeline` does by hand — so a
      // pending case cannot be fused in as its own precedent.
      filter: DECIDED_ONLY,
      // No `weights`. $rankFusion exposes no RRF constant, so the only knob is the per-branch
      // weight, and there is no measurement here to justify moving it off 1:1 (see config.ts).
    });
    return hits.map(toHit);
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
  private async graphChain(
    accountId: string, maxDepth: number,
  ): Promise<{ chain?: any[]; status: TraceStatus }> {
    try {
      const docs = await this.col().aggregate(buildGraphPipeline(accountId, { maxDepth })).toArray();
      // No document means the seed `$match` on `sender.account_number` matched nothing: this account
      // has never sent a transaction in this corpus. That is NOT the same as a clean trace, and the
      // pipeline's `$limit 1` makes the distinction free — see TraceStatus for why it must survive.
      if (!docs[0]) {
        logger.warn('fund-trace found no such sender account; reporting not-found, not clean', {
          account: accountId, maxDepth,
        });
        return { chain: [], status: 'account_not_found' };
      }
      return { ...(docs[0] as { chain?: any[] }), status: 'complete' };
    } catch (err) {
      // Only the memory ceiling is tolerated. Anything else (auth, a malformed pipeline, a dropped
      // connection) is a real fault and must not be silently reported as a clean fund-trace.
      if ((err as { code?: number })?.code !== 40099) throw err;
      logger.warn('fund-trace exceeded the $graphLookup memory limit; ring signal is incomplete', {
        account: accountId, maxDepth,
      });
      // 'incomplete', not 'complete': the account is real and may well be ringed — we ran out of
      // memory before we could tell. Reporting this as a finished, clean trace is the same
      // absence-of-evidence-as-evidence-of-absence error as the not-found case above.
      return { chain: [], status: 'incomplete' };
    }
  }

  /** Trace the sender's transfer network and summarize fraud-ring signals. */
  async traceFunds(accountId: string, maxDepth = 3): Promise<RingSummary> {
    const doc = await this.graphChain(accountId, maxDepth);
    return summarizeRing(doc, accountId, doc.status);
  }

  /** Trace + return the raw edges (for the ring visualization) alongside the summary. */
  async traceFundsGraph(accountId: string, maxDepth = 3): Promise<RingSummary & { edges: { from: string; to: string; amount: number }[] }> {
    const doc = await this.graphChain(accountId, maxDepth);
    const summary = summarizeRing(doc as any, accountId, doc.status);
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
