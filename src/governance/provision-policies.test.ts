import { describe, it, expect } from 'vitest';
import { provisionPolicyIndexes } from './provision-policies';
import { POLICY_VECTOR_INDEX, POLICY_SEARCH_INDEX } from './policies';
import { EMBED_DIM } from '../mastra/schemas/transactions';

/** Live definition as Atlas reports it, in the shape `latestDefinition` comes back in. */
const liveDefinition = (over: Partial<{ dims: number; similarity: string; filters: string[] }> = {}) => ({
  fields: [
    {
      type: 'vector', path: 'embedding',
      numDimensions: over.dims ?? EMBED_DIM,
      similarity: over.similarity ?? 'cosine',
    },
    ...(over.filters ?? ['is_current_version', 'category']).map(path => ({ type: 'filter', path })),
  ],
});

function fakeDb(opts: { existing?: { vector?: any; search?: boolean } } = {}) {
  const calls: string[] = [];
  const indexCalls: any[] = [];
  let captured: any = null;
  const live: any[] = [];
  if (opts.existing?.vector) {
    live.push({
      name: POLICY_VECTOR_INDEX, queryable: true, status: 'READY',
      latestDefinition: opts.existing.vector,
    });
  }
  if (opts.existing?.search) live.push({ name: POLICY_SEARCH_INDEX, queryable: true, status: 'READY' });

  const db = {
    collection: () => ({
      createIndex: async (spec: any, o?: any) => { indexCalls.push({ spec, o }); return 'ok'; },
      listSearchIndexes: () => ({ toArray: async () => live }),
      createSearchIndex: async (d: any) => {
        calls.push(`create:${d.name}`);
        if (d.name === POLICY_VECTOR_INDEX) captured = d.definition;
        live.push({ name: d.name, queryable: true, status: 'READY', latestDefinition: d.definition });
        return d.name;
      },
      updateSearchIndex: async (name: string, definition: any) => {
        calls.push(`update:${name}`);
        captured = definition;
        const i = live.findIndex(x => x.name === name);
        if (i >= 0) live[i] = { name, queryable: true, status: 'READY', latestDefinition: definition };
      },
    }),
  } as any;
  return { db, calls, indexCalls, captured: () => captured };
}

describe('provisionPolicyIndexes', () => {
  const vectorField = (def: any) => def.fields.find((f: any) => f.type === 'vector');

  it('creates both search indexes and the partial-unique index on a fresh collection', async () => {
    const { db, calls, indexCalls, captured } = fakeDb();
    await provisionPolicyIndexes(db, { waitDelayMs: 1 });
    expect(calls).toEqual([`create:${POLICY_VECTOR_INDEX}`, `create:${POLICY_SEARCH_INDEX}`]);
    expect(vectorField(captured())).toEqual({
      type: 'vector', path: 'embedding', numDimensions: EMBED_DIM, similarity: 'cosine',
    });
    // Both filter paths must reach Atlas: reviewAction filters on is_current_version, and a filter
    // path absent from the definition makes the query an ERROR rather than an ignored clause.
    expect(captured().fields).toContainEqual({ type: 'filter', path: 'is_current_version' });
    expect(captured().fields).toContainEqual({ type: 'filter', path: 'category' });
    expect(indexCalls).toContainEqual({
      spec: { policy_code: 1 },
      o: {
        unique: true, partialFilterExpression: { is_current_version: true },
        name: 'policy_code_current_unique',
      },
    });
  });

  it('UPDATES an existing index whose definition no longer matches the code', async () => {
    // The regression this guards: the function used to skip creation whenever the index NAME
    // existed, so editing the definition had no effect on any provisioned cluster — silently. A
    // governance-filter fix looked deployed while every query ran the old definition.
    const { db, calls, captured } = fakeDb({
      existing: { vector: liveDefinition({ filters: ['is_current_version'] }) },
    });
    await provisionPolicyIndexes(db, { waitDelayMs: 1 });
    expect(calls).toContain(`update:${POLICY_VECTOR_INDEX}`);
    expect(captured().fields).toContainEqual({ type: 'filter', path: 'category' });
  });

  it('updates when the dimension count drifts, which a model change would cause', async () => {
    const { db, calls } = fakeDb({ existing: { vector: liveDefinition({ dims: 512 }) } });
    await provisionPolicyIndexes(db, { waitDelayMs: 1 });
    expect(calls).toContain(`update:${POLICY_VECTOR_INDEX}`);
  });

  it('updates when the similarity function differs', async () => {
    const { db, calls } = fakeDb({ existing: { vector: liveDefinition({ similarity: 'euclidean' }) } });
    await provisionPolicyIndexes(db, { waitDelayMs: 1 });
    expect(calls).toContain(`update:${POLICY_VECTOR_INDEX}`);
  });

  it('does not touch an index that already matches', async () => {
    const { db, calls } = fakeDb({ existing: { vector: liveDefinition(), search: true } });
    await provisionPolicyIndexes(db, { waitDelayMs: 1 });
    expect(calls).toEqual([]);
  });

  it('ignores field ORDER, so reordering the definition does not trigger a rebuild', async () => {
    // Atlas does not care about order; JSON.stringify does. Comparing serialized definitions would
    // rebuild on every deploy after a cosmetic reorder.
    const reordered = {
      fields: [
        { type: 'filter', path: 'category' },
        { type: 'vector', path: 'embedding', numDimensions: EMBED_DIM, similarity: 'cosine' },
        { type: 'filter', path: 'is_current_version' },
      ],
    };
    const { db, calls } = fakeDb({ existing: { vector: reordered, search: true } });
    await provisionPolicyIndexes(db, { waitDelayMs: 1 });
    expect(calls).toEqual([]);
  });

  it('waits for READY on the update path, not merely for queryable', async () => {
    // Atlas keeps the OLD definition queryable while an update builds, so `queryable: true` arrives
    // immediately and says nothing about the new definition.
    let polls = 0;
    const db = {
      collection: () => ({
        createIndex: async () => 'ok',
        listSearchIndexes: () => ({
          toArray: async () => {
            polls++;
            return [{
              name: POLICY_VECTOR_INDEX,
              queryable: true,                        // true throughout — the old index serves
              status: polls > 3 ? 'READY' : 'BUILDING',
              latestDefinition: liveDefinition({ filters: ['is_current_version'] }),
            }];
          },
        }),
        createSearchIndex: async (d: any) => d.name,
        updateSearchIndex: async () => {},
      }),
    } as any;
    await provisionPolicyIndexes(db, { waitDelayMs: 1 });
    expect(polls).toBeGreaterThan(3);
  });

  it('still creates the vector index when listSearchIndexes is unreadable', async () => {
    // A permissions or transient failure reading the index list must not be mistaken for
    // "the index already exists".
    const calls: string[] = [];
    const db = {
      collection: () => ({
        createIndex: async () => 'ok',
        listSearchIndexes: () => ({ toArray: async () => { throw new Error('not authorized'); } }),
        createSearchIndex: async (d: any) => { calls.push(`create:${d.name}`); return d.name; },
        updateSearchIndex: async () => {},
      }),
    } as any;
    await provisionPolicyIndexes(db, { waitDelayMs: 1 });
    expect(calls).toContain(`create:${POLICY_VECTOR_INDEX}`);
  });
});
