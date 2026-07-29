import { describe, it, expect, vi } from 'vitest';
import { Decimal128 } from 'mongodb';
import { RetrievalService } from './service';
import { VECTOR_CANDIDATE_FLOOR } from './pipelines';
import { TRANSACTIONS_SEARCH_INDEX, DECIDED_STATUSES } from '../mastra/schemas/transactions';

// Fake Db that records the pipeline passed to aggregate and returns scripted docs. `throws` makes
// toArray() reject instead, for the server-error paths. Only the graph path goes through this now —
// the three search reads go through the store below.
function fakeDb(returnDocs: any[], throws?: { code?: number; message?: string }) {
  const calls: any[][] = [];
  const db = {
    collection() {
      return {
        aggregate(pipeline: any[]) {
          calls.push(pipeline);
          return {
            toArray: async () => {
              if (throws) {
                const err: any = new Error(throws.message ?? 'server error');
                if (throws.code !== undefined) err.code = throws.code;
                throw err;
              }
              return returnDocs;
            },
          };
        },
      };
    },
  };
  return { db, calls };
}

/**
 * Fake `MongoDBVector` recording the params of each read and returning DOCUMENT-MODE results.
 *
 * The shape matters: in `metadataMode: 'document'` the library projects `metadata: '$$ROOT'`, so a
 * hit is `{id, score, metadata: <the whole source transaction>}` — never the source document at the
 * top level. A fake that returned the flat document would let a `r.transaction_id` regression pass
 * here and fail only against Atlas, as `undefined` in every field.
 */
function fakeStore(metadatas: Record<string, any>[]) {
  const calls: { method: string; params: any }[] = [];
  const results = metadatas.map((m, i) => ({ id: `id-${i}`, score: 0.9 - i * 0.1, metadata: m }));
  const record = (method: string) => async (params: any) => { calls.push({ method, params }); return results; };
  const store = { query: record('query'), textQuery: record('textQuery'), hybridQuery: record('hybridQuery') };
  const paramsOf = (method: string) => calls.find(c => c.method === method)!.params;
  return { store, calls, paramsOf };
}

/** A source transaction as document mode returns it, including the fields toHit must NOT carry. */
function sourceDoc(over: Record<string, any> = {}) {
  return {
    _id: 'bson-object-id',
    transaction_id: 't1',
    text: 'cash deposit',
    amount: Decimal128.fromString('4950.00'),
    currency: 'USD',
    sender: { name: 'A Sender', account_number: 'ACC-1' },
    recipient: { name: 'A Recipient', account_number: 'ACC-2' },
    status: 'approved',
    lane: 'structuring',
    ...over,
  };
}

const embed = vi.fn(async () => Array.from({ length: 1024 }, () => 0.02));
const svcWith = (store: any, db: any = fakeDb([]).db) => new RetrievalService(db, store, embed);

describe('RetrievalService search reads', () => {
  it('vector() embeds the query and queries the store', async () => {
    const { store, paramsOf } = fakeStore([sourceDoc()]);
    const hits = await svcWith(store).vector('structuring', 3);
    expect(embed).toHaveBeenCalledWith('structuring');
    expect(paramsOf('query').queryVector).toHaveLength(1024);
    expect(paramsOf('query').topK).toBe(3);
    expect(hits[0].transaction_id).toBe('t1');
  });

  it('lexical() runs a text query without embedding', async () => {
    const { store, paramsOf } = fakeStore([sourceDoc({ transaction_id: 't2' })]);
    embed.mockClear();
    const hits = await svcWith(store).lexical('cash deposit', 5);
    expect(embed).not.toHaveBeenCalled();
    expect(paramsOf('textQuery').query).toBe('cash deposit');
    expect(hits[0].transaction_id).toBe('t2');
  });

  it('hybrid() runs a hybrid query carrying both the vector and the text', async () => {
    const { store, paramsOf } = fakeStore([sourceDoc({ transaction_id: 't3' })]);
    const hits = await svcWith(store).hybrid('ring', 5);
    expect(paramsOf('hybridQuery').queryVector).toHaveLength(1024);
    expect(paramsOf('hybridQuery').query).toBe('ring');
    expect(hits[0].transaction_id).toBe('t3');
  });

  describe('numCandidates is passed explicitly', () => {
    // THE REGRESSION THIS GUARDS, and it is invisible to every other check. The library defaults
    // `numCandidates` to `topK * 20` — at this app's k=5 that is 100, and 100 candidates measured a
    // **p99 of 1.9 s** against the binary-quantized 1M index where 200 measured 28.5 ms. Omitting
    // the argument reads as accepting a sensible default; it is a ~60x tail regression that a
    // 12k-document corpus cannot reproduce and that no result-correctness test can see, because the
    // documents that come back are the same ones.
    it('vector() floors it at VECTOR_CANDIDATE_FLOOR', async () => {
      const { store, paramsOf } = fakeStore([]);
      await svcWith(store).vector('q', 5);
      expect(paramsOf('query').numCandidates).toBeGreaterThanOrEqual(VECTOR_CANDIDATE_FLOOR);
    });

    it('hybrid() floors it at VECTOR_CANDIDATE_FLOOR', async () => {
      const { store, paramsOf } = fakeStore([]);
      await svcWith(store).hybrid('q', 5);
      expect(paramsOf('hybridQuery').numCandidates).toBeGreaterThanOrEqual(VECTOR_CANDIDATE_FLOOR);
    });

    it('a large topK raises it above the floor', async () => {
      const { store, paramsOf } = fakeStore([]);
      await svcWith(store).vector('q', 100);
      expect(paramsOf('query').numCandidates).toBe(1000);
    });
  });

  describe('the text index is named explicitly', () => {
    // So no code path can reach the library's `resolveTextSearchIndexName`, which for a BYO
    // collection throws unless `createSearchIndex` registered a text index — and registering one is
    // the thing to avoid: it would either clobber the app's tuned static BM25 mapping or leave a
    // second, unused Lucene index over 1M documents.
    it('lexical() passes searchIndexName', async () => {
      const { store, paramsOf } = fakeStore([]);
      await svcWith(store).lexical('q', 5);
      expect(paramsOf('textQuery').searchIndexName).toBe(TRANSACTIONS_SEARCH_INDEX);
    });

    it('hybrid() passes textSearchIndexName', async () => {
      const { store, paramsOf } = fakeStore([]);
      await svcWith(store).hybrid('q', 5);
      expect(paramsOf('hybridQuery').textSearchIndexName).toBe(TRANSACTIONS_SEARCH_INDEX);
    });
  });

  describe('metadataMode and the precedent filter', () => {
    it("every read asks for 'document' mode", async () => {
      // 'field' (the default) projects `metadata: '$metadata'`, and these BYO operational documents
      // have no managed `metadata` subdocument — so every hit would come back with every field
      // undefined, with nothing thrown.
      const { store, paramsOf } = fakeStore([]);
      const svc = svcWith(store);
      await svc.vector('q'); await svc.lexical('q'); await svc.hybrid('q');
      for (const m of ['query', 'textQuery', 'hybridQuery']) {
        expect(paramsOf(m).metadataMode).toBe('document');
      }
    });

    it('vector() and hybrid() restrict to decided cases', async () => {
      // Both claim PRECEDENT, and a pending case is not a precedent — least of all its own.
      const expected = { status: { $in: [...DECIDED_STATUSES] } };
      const { store, paramsOf } = fakeStore([]);
      const svc = svcWith(store);
      await svc.vector('q'); await svc.hybrid('q');
      expect(paramsOf('query').filter).toEqual(expected);
      expect(paramsOf('hybridQuery').filter).toEqual(expected);
    });

    it('lexical() passes no status filter', async () => {
      // Matches buildLexicalPipeline: this tool exists for exact names and codes, where excluding
      // pending cases would hide the live case an investigator is looking up by name.
      const { store, paramsOf } = fakeStore([]);
      await svcWith(store).lexical('Quartz Trading');
      expect(paramsOf('textQuery').filter).toBeUndefined();
    });
  });

  describe('mapping a document-mode result into a RetrievalHit', () => {
    it('reads the fields off metadata, not off the top level', async () => {
      const { store } = fakeStore([sourceDoc()]);
      const [hit] = await svcWith(store).vector('q');
      expect(hit).toMatchObject({
        transaction_id: 't1', text: 'cash deposit', currency: 'USD', status: 'approved',
        lane: 'structuring',
        sender: { name: 'A Sender', account_number: 'ACC-1' },
        recipient: { name: 'A Recipient', account_number: 'ACC-2' },
      });
      expect(hit.score).toBe(0.9);
    });

    it('drops _id and anything else the source document carries', async () => {
      // These hits are PERSISTED — run-engine writes them into `case_analysis.precedents` through
      // the app's own mongodb 6 driver. `@mastra/mongodb` bundles mongodb 7, so the `_id` document
      // mode hands back is a bson 7 ObjectId, and bson 6 does not merely mis-handle a foreign BSON
      // class, it REFUSES it: `BSONVersionError: Unsupported BSON version, bson types must be from
      // bson 6.x.x`. A spread instead of a field-by-field mapping would therefore turn every
      // investigation into an `error` event at the write, not at the read.
      const { store } = fakeStore([sourceDoc({ embedding: [0.1], internal_note: 'x' })]);
      const [hit] = await svcWith(store).vector('q');
      expect(Object.keys(hit).sort()).toEqual([
        'amount', 'currency', 'lane', 'recipient', 'score', 'sender', 'status', 'text',
        'transaction_id',
      ]);
    });

    it('re-homes amount onto the app\'s own bson, exactly', async () => {
      // The same cross-driver hazard as above, for the one field that must survive. `String()` on a
      // Decimal128 of either vintage yields the same decimal text and `toMoney` rebuilds it through
      // the app's `Decimal128.fromString`, so the value is preserved rather than approximated.
      const { store } = fakeStore([sourceDoc({ amount: Decimal128.fromString('1256.00') })]);
      const [hit] = await svcWith(store).vector('q');
      expect(hit.amount).toBeInstanceOf(Decimal128);
      expect(String(hit.amount)).toBe('1256.00');
    });

    it('normalizes a pre-migration number amount to the money scale', async () => {
      const { store } = fakeStore([sourceDoc({ amount: 4950 })]);
      const [hit] = await svcWith(store).vector('q');
      expect(String(hit.amount)).toBe('4950.00');
    });
  });
});

describe('RetrievalService fund tracing', () => {
  const noStore = fakeStore([]).store;

  it('traceFunds() summarizes a graphLookup chain into ring signals', async () => {
    const doc = {
      chain: [
        { sender: { account_number: 'A' }, recipient: { account_number: 'B' }, amount: 900 },
        { sender: { account_number: 'B' }, recipient: { account_number: 'A' }, amount: 850 },
      ],
    };
    const { db } = fakeDb([doc]);
    const svc = svcWith(noStore, db);
    const ring = await svc.traceFunds('A');
    expect(ring.circular_flow).toBe(true);
    expect(ring.suspicious_patterns).toBe(true);
  });

  it('still runs a $graphLookup on the app\'s own driver, not through the store', async () => {
    // $graphLookup has no library equivalent, so the traversal deliberately stays on the v6 Db.
    const { db, calls } = fakeDb([{ chain: [] }]);
    await svcWith(noStore, db).traceFunds('A');
    expect(calls[0].some(s => (s as any).$graphLookup)).toBe(true);
  });

  describe('an account that does not exist', () => {
    // THE REGRESSION THIS GUARDS. The seed `$match` on sender.account_number matched nothing, the
    // aggregate returned no document, and the old code turned that into `{ chain: [] }` — which
    // summarizes identically to a real account that transfers to nobody. Measured consequence: all
    // three models, given no account number in the narrative, invented one ('<UNKNOWN>',
    // 'quartz_trading', 'Quartz Trading'), and the fabrication came back as a confident
    // `circular_flow=false layering=false` on txn-review-ring — a case that IS a ring. The false
    // negative then reached `verdict.risk_factors`, which is merged into the hash-sealed snapshot.
    it('traceFunds() reports account_not_found, not a clean trace', async () => {
      const { db } = fakeDb([]); // no matching seed document
      const svc = svcWith(noStore, db);
      const ring = await svc.traceFunds('NO-SUCH-ACCOUNT');
      expect(ring.trace_status).toBe('account_not_found');
      expect(ring.suspicious_patterns).toBe(false);
      expect(ring.network_size).toBe(0);
    });

    it('traceFundsGraph() reports account_not_found too', async () => {
      const { db } = fakeDb([]);
      const svc = svcWith(noStore, db);
      const ring = await svc.traceFundsGraph('<UNKNOWN>');
      expect(ring.trace_status).toBe('account_not_found');
      expect(ring.edges).toEqual([]);
    });

    it('a real account with no outgoing edges is complete, not not-found', async () => {
      // The other side of the distinction: this account EXISTS and genuinely transfers to nobody.
      // An empty chain here is real evidence, and collapsing it into 'account_not_found' would
      // make every quiet account look like a data error.
      const { db } = fakeDb([{ chain: [] }]);
      const svc = svcWith(noStore, db);
      expect((await svc.traceFunds('ACC-QUIET')).trace_status).toBe('complete');
    });
  });

  describe('the $graphLookup memory limit (code 40099)', () => {
    // Measured at 1M documents: a traversal from a densely-connected account exceeds
    // $graphLookup's hard 100MB in-memory ceiling, which it cannot spill to disk. Propagating it
    // aborted the whole case before governance, the audit write and the human-review gate.
    it('traceFunds() degrades to no-ring-found instead of throwing', async () => {
      const { db } = fakeDb([], { code: 40099, message: '$graphLookup reached maximum memory consumption' });
      const svc = svcWith(noStore, db);
      const ring = await svc.traceFunds('ACC-WIDE');
      expect(ring.suspicious_patterns).toBe(false);
      expect(ring.network_size).toBe(0);
    });

    it('reports the degraded trace as incomplete, NOT as a completed clean trace', async () => {
      // The account is real and may well be ringed — we ran out of memory before we could tell.
      // Without this the caller cannot distinguish "we could not look" from "we looked and it is
      // clean", and the second is an absence of evidence presented as evidence of absence.
      const { db } = fakeDb([], { code: 40099 });
      const svc = svcWith(noStore, db);
      expect((await svc.traceFunds('ACC-WIDE')).trace_status).toBe('incomplete');
      expect((await svc.traceFundsGraph('ACC-WIDE')).trace_status).toBe('incomplete');
    });

    it('traceFundsGraph() degrades to an empty edge list', async () => {
      const { db } = fakeDb([], { code: 40099 });
      const svc = svcWith(noStore, db);
      const ring = await svc.traceFundsGraph('ACC-WIDE');
      expect(ring.edges).toEqual([]);
      expect(ring.circular_flow).toBe(false);
    });

    it('does NOT swallow any other server error', async () => {
      // An auth failure or a dropped connection reported as "fund-trace clean" would be a silent
      // loss of evidence — the case would reach a decision on a signal that was never measured.
      const { db } = fakeDb([], { code: 13, message: 'not authorized' });
      const svc = svcWith(noStore, db);
      await expect(svc.traceFunds('A')).rejects.toThrow('not authorized');
      await expect(svc.traceFundsGraph('A')).rejects.toThrow('not authorized');
    });

    it('does not swallow an error with no code at all', async () => {
      const { db } = fakeDb([], { message: 'connection reset' });
      const svc = svcWith(noStore, db);
      await expect(svc.traceFunds('A')).rejects.toThrow('connection reset');
    });
  });
});
