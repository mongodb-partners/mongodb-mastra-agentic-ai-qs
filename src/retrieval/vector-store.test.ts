import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { MongoDBVector } from '@mastra/mongodb';
import { TRANSACTIONS_INDEX, POLICIES_INDEX, registerByoIndexes } from './vector-store';
import { TRANSACTIONS_COLLECTION, TRANSACTIONS_VECTOR_INDEX, EMBED_DIM } from '../mastra/schemas/transactions';
import { POLICIES_COLLECTION, POLICY_VECTOR_INDEX } from '../governance/policies';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

/** Parse an exact pin ("1.15.0") into a comparable tuple. Ranges are rejected — see the test below. */
function parsePin(spec: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(spec);
  if (!m) throw new Error(`expected an exact version pin, got ${spec}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

const atLeast = (spec: string, floor: string) => {
  const [a, b, c] = parsePin(spec);
  const [x, y, z] = parsePin(floor);
  return a !== x ? a > x : b !== y ? b > y : c >= z;
};

describe('vector store dependency floors', () => {
  // WHY FLOORS ARE ASSERTED. Both features this app depends on landed in a specific release, and
  // downgrading either one fails in a way that does not look like a version problem:
  //   - @mastra/mongodb 1.15.0 is the first release with BYO collections, `textQuery` and
  //     `hybridQuery` (upstream mastra#19805). Below it, `createIndex` has no `collectionName`, so
  //     the store would create its OWN `transactions` collection alongside the real one and query an
  //     empty index — zero precedents, no error.
  //   - @mastra/core 1.53.0 is the real floor, and it is NOT the one @mastra/mongodb declares. Its
  //     peer range says `>=1.51.0-0 <2.0.0-0`, but its entry point statically imports
  //     `storageMessageMatchesMetadataFilter` from `@mastra/core/storage`, which core only began
  //     exporting in 1.53.0 (absent in 1.51.0, 1.52.0 and 1.52.1 — checked against the published
  //     tarballs). Because the import is top-level, the whole module fails to evaluate, so `import
  //     { MongoDBVector }` throws a SyntaxError at load even though nothing here touches memory
  //     storage. Installing a satisfied-but-too-low peer therefore breaks retrieval at startup with
  //     a message that names a storage symbol this app never uses — hence the explicit floor.
  it('pins @mastra/mongodb at or above the release that shipped BYO + textQuery + hybridQuery', () => {
    expect(atLeast(pkg.dependencies['@mastra/mongodb'], '1.15.0')).toBe(true);
  });

  it('pins @mastra/core at or above what @mastra/mongodb actually imports, not what it peers on', () => {
    expect(atLeast(pkg.dependencies['@mastra/core'], '1.53.0')).toBe(true);
  });

  it('can actually load MongoDBVector', () => {
    // The assertion above is a proxy; this is the real property. It fails on a too-low core with the
    // SyntaxError described above, and it is the cheapest possible guard against a whole class of
    // "peer range says yes, runtime says no" breakage in this dependency.
    expect(typeof MongoDBVector).toBe('function');
  });

  it('pins both exactly, not as a range', () => {
    // A caret range on either would let a fresh `pnpm install` drift onto an untested minor of the
    // packages this demo exists to exercise. `parsePin` throws on anything but x.y.z.
    for (const dep of ['@mastra/core', '@mastra/mongodb', '@mastra/voyageai']) {
      expect(() => parsePin(pkg.dependencies[dep])).not.toThrow();
    }
  });
});

describe('logical index keys', () => {
  // These are registry keys, and the registry is DURABLE (`__mastra_vector_indexes__`). Changing a
  // value here does not fail — it silently stops resolving to the entry written by the last
  // provision, so `resolveIndexTarget` falls back to its managed-index default: collectionName ==
  // indexName, isByo false. The query then runs against a collection the app never seeded.
  it('are stable values', () => {
    expect(TRANSACTIONS_INDEX).toBe('transactions');
    expect(POLICIES_INDEX).toBe('policies');
  });

  it('are distinct from each other', () => {
    expect(TRANSACTIONS_INDEX).not.toBe(POLICIES_INDEX);
  });

  it('map to the collections the app actually seeds', () => {
    // The logical key is passed as `collectionName` at registration. If it ever stopped matching the
    // real collection, `createIndex` would either throw (collection absent) or register a BYO target
    // pointing at the wrong data.
    expect(TRANSACTIONS_INDEX).toBe(TRANSACTIONS_COLLECTION);
    expect(POLICIES_INDEX).toBe(POLICIES_COLLECTION);
  });

  it('leave the app vector index names clear of the librarys CONFLICT check', () => {
    // `createIndex` throws CONFLICT if the vector index name it is asked for equals
    // `${collectionName}_search_index` — the name it reserves for the companion text index. The
    // app's own constants are what get passed as `searchIndexName`, so this compares THOSE against
    // the reserved name rather than comparing two literals.
    expect(TRANSACTIONS_VECTOR_INDEX).not.toBe(`${TRANSACTIONS_COLLECTION}_search_index`);
    expect(POLICY_VECTOR_INDEX).not.toBe(`${POLICIES_COLLECTION}_search_index`);
  });
});

describe('registerByoIndexes', () => {
  /** A store recording every createIndex call; `fail` makes the nth call reject. */
  function fakeStore(fail?: (n: number) => boolean) {
    const calls: any[] = [];
    const vector = {
      async createIndex(params: any) {
        calls.push(params);
        if (fail?.(calls.length)) throw new Error('index not found');
      },
    };
    return { vector: vector as any, calls };
  }

  it('registers both collections against the apps own Atlas indexes', async () => {
    const { vector, calls } = fakeStore();
    expect(await registerByoIndexes(vector)).toEqual([TRANSACTIONS_INDEX, POLICIES_INDEX]);
    expect(calls.map(c => [c.indexName, c.collectionName, c.searchIndexName])).toEqual([
      [TRANSACTIONS_INDEX, TRANSACTIONS_COLLECTION, TRANSACTIONS_VECTOR_INDEX],
      [POLICIES_INDEX, POLICIES_COLLECTION, POLICY_VECTOR_INDEX],
    ]);
  });

  it('passes collectionName, which is the ONLY thing that makes the index bring-your-own', async () => {
    // `isByo = collectionName !== undefined` inside createIndex. Omitting it does not error — the
    // store would create and own a NEW collection named after the logical key, then query an empty
    // index: zero precedents, no failure. It would also then be writable, since the read-only
    // guard only applies to BYO.
    const { vector, calls } = fakeStore();
    await registerByoIndexes(vector);
    for (const c of calls) expect(c.collectionName).toBeTruthy();
  });

  it('never opts in to writes, so both indexes stay read-only', async () => {
    // `allowWrites` defaults to false, so this asserts the key is ABSENT rather than falsy — an
    // explicit `allowWrites: true` added later is the thing worth catching, and it would let the
    // store mutate documents whose evidence hash is sealed in the audit chain.
    const { vector, calls } = fakeStore();
    await registerByoIndexes(vector);
    for (const c of calls) expect('allowWrites' in c).toBe(false);
  });

  it('declares no filterFields, which would be prefixed with metadata.', async () => {
    // `buildDeclaredMetadataPaths` turns ['status'] into ['metadata.status'] — a path these
    // documents do not have. Pushdown comes from the app's own `{type:'filter',path:'status'}` in
    // the live definition instead, which `getDeclaredFilterPaths` reads back.
    const { vector, calls } = fakeStore();
    await registerByoIndexes(vector);
    for (const c of calls) expect('filterFields' in c).toBe(false);
  });

  it('passes the shared embedding dimension, so a model change moves both together', async () => {
    const { vector, calls } = fakeStore();
    await registerByoIndexes(vector);
    for (const c of calls) {
      expect(c.dimension).toBe(EMBED_DIM);
      expect(c.metric).toBe('cosine');
    }
  });

  it('keeps registering after one collection fails, and reports only what succeeded', async () => {
    // A provision run has already done all its real work by the time this executes, so one failed
    // registration must not abort the other or fail the run.
    const { vector } = fakeStore(n => n === 1);
    expect(await registerByoIndexes(vector)).toEqual([POLICIES_INDEX]);
  });
});
