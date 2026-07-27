import { describe, it, expect } from 'vitest';
import {
  parseMajorMinor, supportsRankFusion, provisionGraphIndexes, provisionTransactionSearchIndex,
  provisionTransactionVectorIndex, quantizationForCorpus, BINARY_QUANTIZATION_MIN_DOCS,
} from './provision-transactions';
import { TRANSACTIONS_SEARCH_INDEX, TRANSACTIONS_VECTOR_INDEX, EMBED_DIM } from '../mastra/schemas/transactions';

describe('rank-fusion version guard', () => {
  it('parses major.minor', () => {
    expect(parseMajorMinor('8.0.4')).toEqual([8, 0]);
    expect(parseMajorMinor('7.3.1')).toEqual([7, 3]);
  });
  it('accepts 8.0+ and rejects older', () => {
    expect(supportsRankFusion('8.0.0')).toBe(true);
    expect(supportsRankFusion('8.1.2')).toBe(true);
    expect(supportsRankFusion('7.0.14')).toBe(false);
    expect(supportsRankFusion('6.0.0')).toBe(false);
  });
});

describe('provisionGraphIndexes', () => {
  function fakeDb(created: string[], indexesAfter: () => { name: string }[], failOn?: string) {
    return {
      collection: () => ({
        createIndex: async (spec: Record<string, number>) => {
          const field = Object.keys(spec)[0];
          if (field === failOn) throw new Error(`simulated build failure on ${field}`);
          const name = `${field}_1`;
          created.push(name);
          return name;
        },
        indexes: async () => indexesAfter(),
      }),
    } as any;
  }

  it('creates a single-field index on each graph traversal field', async () => {
    // Single-field on purpose: a covering compound index measured 46ms vs 48ms (noise) because
    // $graphLookup fetches full documents during traversal and never uses a covered scan.
    const created: string[] = [];
    const names = await provisionGraphIndexes(fakeDb(created, () => [
      { name: '_id_' }, { name: 'sender.account_number_1' }, { name: 'recipient.account_number_1' },
    ]));
    expect(created).toEqual(['sender.account_number_1', 'recipient.account_number_1']);
    expect(names).toEqual(['sender.account_number_1', 'recipient.account_number_1']);
  });

  it('THROWS when an index is missing afterward, naming the field', async () => {
    // Every other createIndex in this codebase is suffixed .catch(() => {}), which makes a failed
    // build indistinguishable from a successful one. A missing graph index does not fail a query,
    // it degrades $graphLookup to a collection scan per depth level — so it would surface as an
    // unexplained slow benchmark rather than an error. These two must be loud.
    const created: string[] = [];
    await expect(
      provisionGraphIndexes(fakeDb(created, () => [{ name: '_id_' }, { name: 'sender.account_number_1' }])),
    ).rejects.toThrow(/recipient\.account_number/);
  });

  it('THROWS when createIndex itself rejects, rather than swallowing it', async () => {
    const created: string[] = [];
    await expect(
      provisionGraphIndexes(fakeDb(created, () => [{ name: '_id_' }], 'sender.account_number')),
    ).rejects.toThrow(/simulated build failure/);
  });
});

describe('quantizationForCorpus', () => {
  it('is binary at 1M and none at the app scale', () => {
    // Not a preference — a measured, scale-dependent verdict. At 1M a float32 index is ~4GB on an
    // 8GB cluster and cannot stay resident ($vectorSearch alone measured p50 2960ms); at 12k it is
    // ~49MB and recall is already 1.0000 at every candidate level, where binary only loses recall.
    expect(quantizationForCorpus(1_000_015)).toBe('binary');
    expect(quantizationForCorpus(12_015)).toBe('none');
  });
  it('puts neither corpus scale near the threshold', () => {
    // The seeded scale (~12k) and the benchmark scale (1M) sit ~8x below and ~10x above, so a corpus
    // drifting by a few thousand documents can never flip the encoding underneath a deployment.
    expect(BINARY_QUANTIZATION_MIN_DOCS).toBeGreaterThan(12_015 * 4);
    expect(BINARY_QUANTIZATION_MIN_DOCS).toBeLessThan(1_000_015 / 4);
  });
  it('treats an unreadable count (0) as the small corpus', () => {
    expect(quantizationForCorpus(0)).toBe('none');
  });
});

describe('provisionTransactionVectorIndex', () => {
  function fakeDb(opts: { docCount: number; existingQuantization?: 'none' | 'binary' | 'absent' }) {
    const calls: string[] = [];
    let live: any = opts.existingQuantization === undefined ? null : {
      name: TRANSACTIONS_VECTOR_INDEX,
      queryable: true,
      status: 'READY',
      latestDefinition: {
        fields: [
          opts.existingQuantization === 'absent'
            ? { type: 'vector', path: 'embedding' }
            : { type: 'vector', path: 'embedding', quantization: opts.existingQuantization },
          { type: 'filter', path: 'status' },
        ],
      },
    };
    let captured: any = null;
    const db = {
      collection: () => ({
        createIndex: async () => 'ok',
        estimatedDocumentCount: async () => opts.docCount,
        listSearchIndexes: () => ({ toArray: async () => (live ? [live] : []) }),
        createSearchIndex: async (d: any) => {
          calls.push(`create:${d.name}`);
          captured = d.definition;
          live = { name: d.name, queryable: true, status: 'READY', latestDefinition: d.definition };
          return d.name;
        },
        updateSearchIndex: async (name: string, definition: any) => {
          calls.push(`update:${name}`);
          captured = definition;
          live = { name, queryable: true, status: 'READY', latestDefinition: definition };
        },
      }),
    } as any;
    return { db, calls, captured: () => captured };
  }

  const vectorField = (def: any) => def.fields.find((f: any) => f.type === 'vector');

  it('creates a 1M index with binary quantization', async () => {
    const { db, calls, captured } = fakeDb({ docCount: 1_000_015 });
    await provisionTransactionVectorIndex(db);
    expect(calls).toEqual([`create:${TRANSACTIONS_VECTOR_INDEX}`]);
    expect(vectorField(captured())).toEqual({
      type: 'vector', path: 'embedding', numDimensions: EMBED_DIM,
      similarity: 'cosine', quantization: 'binary',
    });
    // The status filter is what lets $vectorSearch restrict to decided precedents; dropping it
    // from the definition makes the filter in buildVectorPipeline an error, not a no-op.
    expect(captured().fields).toContainEqual({ type: 'filter', path: 'status' });
  });

  it('creates an app-scale index unquantized', async () => {
    const { db, captured } = fakeDb({ docCount: 12_015 });
    await provisionTransactionVectorIndex(db);
    expect(vectorField(captured()).quantization).toBe('none');
  });

  it('UPDATES an existing index whose quantization is wrong for its corpus size', async () => {
    // The regression this guards: the function used to return early whenever the index name
    // existed, so changing the definition in code had no effect on any provisioned cluster —
    // silently. A quantization fix looked deployed while every query still hit float32.
    const { db, calls, captured } = fakeDb({ docCount: 1_000_015, existingQuantization: 'none' });
    await provisionTransactionVectorIndex(db);
    expect(calls).toEqual([`update:${TRANSACTIONS_VECTOR_INDEX}`]);
    expect(vectorField(captured()).quantization).toBe('binary');
  });

  it('reads a MISSING quantization key as none, since Atlas omits it when unquantized', async () => {
    const { db, calls } = fakeDb({ docCount: 1_000_015, existingQuantization: 'absent' });
    await provisionTransactionVectorIndex(db);
    expect(calls).toEqual([`update:${TRANSACTIONS_VECTOR_INDEX}`]);
  });

  it('does not touch an index that already matches', async () => {
    // Idempotence matters more than usual here: an unnecessary update rebuilds a 1M index, which
    // saturates the M30's CPU for ~10 minutes.
    const big = fakeDb({ docCount: 1_000_015, existingQuantization: 'binary' });
    await provisionTransactionVectorIndex(big.db);
    expect(big.calls).toEqual([]);
    const small = fakeDb({ docCount: 12_015, existingQuantization: 'none' });
    await provisionTransactionVectorIndex(small.db);
    expect(small.calls).toEqual([]);
  });

  it('waits for READY on the update path, not merely for queryable', async () => {
    // Atlas keeps the OLD definition queryable while an update builds, so `queryable: true`
    // arrives immediately and says nothing about the new encoding. Returning on it would report a
    // definition change as applied while queries still hit the previous one.
    let polls = 0;
    const db = {
      collection: () => ({
        createIndex: async () => 'ok',
        estimatedDocumentCount: async () => 1_000_015,
        listSearchIndexes: () => ({
          toArray: async () => {
            polls++;
            return [{
              name: TRANSACTIONS_VECTOR_INDEX,
              queryable: true,                       // true throughout — the old index serves
              status: polls > 3 ? 'READY' : 'BUILDING',
              latestDefinition: { fields: [{ type: 'vector', path: 'embedding', quantization: 'none' }] },
            }];
          },
        }),
        createSearchIndex: async (d: any) => d.name,
        updateSearchIndex: async () => {},
      }),
    } as any;
    await provisionTransactionVectorIndex(db, { waitDelayMs: 1 });
    expect(polls).toBeGreaterThan(3);
  });
});

describe('provisionTransactionSearchIndex', () => {
  function fakeDb(existing: { name: string }[], calls: string[]) {
    let captured: any = null;
    // The recreate path waits for the rebuilt index to report queryable, so the fake has to
    // model that: after createSearchIndex, listSearchIndexes reports it queryable.
    let built: { name: string; queryable: boolean }[] = [];
    const db = {
      collection: () => ({
        createIndex: async () => 'ok',
        listSearchIndexes: () => ({ toArray: async () => [...existing, ...built] }),
        dropSearchIndex: async (n: string) => { calls.push(`drop:${n}`); existing = existing.filter(i => i.name !== n); },
        createSearchIndex: async (d: any) => {
          captured = d;
          calls.push(`create:${d.name}`);
          built = [{ name: d.name, queryable: true }];
          return d.name;
        },
      }),
    } as any;
    return { db, captured: () => captured };
  }

  it('uses a static mapping that indexes only the lexical fields, never the embedding', async () => {
    const calls: string[] = [];
    const { db, captured } = fakeDb([], calls);
    await provisionTransactionSearchIndex(db);
    const def = captured().definition;
    // dynamic:true indexed EVERY field, including the 1024-float embedding — a large Lucene
    // index over numbers nothing ever searches lexically.
    expect(def.mappings.dynamic).toBe(false);
    expect(Object.keys(def.mappings.fields).sort()).toEqual(['recipient', 'sender', 'text']);
    expect(def.mappings.fields).not.toHaveProperty('embedding');
    // These are exactly the paths buildLexicalPipeline and the $rankFusion lexical branch query.
    expect(def.mappings.fields.sender.fields.name.type).toBe('string');
    expect(def.mappings.fields.recipient.fields.name.type).toBe('string');
  });

  it('is a no-op when the index already exists and recreate was not asked for', async () => {
    const calls: string[] = [];
    const { db } = fakeDb([{ name: TRANSACTIONS_SEARCH_INDEX }], calls);
    await provisionTransactionSearchIndex(db);
    expect(calls).toEqual([]);
  });

  it('recreates an existing index when asked, since Atlas cannot update a mapping in place', async () => {
    // Without this path the static mapping above would never reach either live cluster: the
    // function returned early whenever the index existed, so a definition change in code was
    // silently a no-op against any cluster already carrying one.
    const calls: string[] = [];
    const { db } = fakeDb([{ name: TRANSACTIONS_SEARCH_INDEX }], calls);
    await provisionTransactionSearchIndex(db, { recreate: true });
    expect(calls).toEqual([`drop:${TRANSACTIONS_SEARCH_INDEX}`, `create:${TRANSACTIONS_SEARCH_INDEX}`]);
  });

  it('waits for the rebuilt index to become queryable before returning', async () => {
    // A drop-and-rebuild leaves the collection with NO lexical index while Atlas builds, and
    // runSearchSelfCheck downstream only retries for ~16s — long enough at 1,200 docs, not at 1M.
    // Returning early would fail the deploy on a perfectly healthy cluster.
    const calls: string[] = [];
    let queryable = false;
    let polls = 0;
    const db = {
      collection: () => ({
        createIndex: async () => 'ok',
        listSearchIndexes: () => ({
          toArray: async () => {
            polls++;
            if (polls > 3) queryable = true; // becomes queryable partway through the wait
            return [{ name: TRANSACTIONS_SEARCH_INDEX, queryable }];
          },
        }),
        dropSearchIndex: async (n: string) => { calls.push(`drop:${n}`); },
        createSearchIndex: async (d: any) => { calls.push(`create:${d.name}`); return d.name; },
      }),
    } as any;
    await provisionTransactionSearchIndex(db, { recreate: true, waitDelayMs: 1 });
    expect(calls).toEqual([`drop:${TRANSACTIONS_SEARCH_INDEX}`, `create:${TRANSACTIONS_SEARCH_INDEX}`]);
    expect(polls).toBeGreaterThan(3); // it actually polled rather than returning immediately
  });
});
