import { describe, it, expect } from 'vitest';
import {
  recordingSource, snapshotReplay, readReplayMeta,
  REPLAY_COLLECTIONS, RECORDING_COLLECTIONS, REPLAY_META_COLLECTION,
} from './replay-store';
import { TRANSACTIONS_COLLECTION } from '../mastra/schemas/transactions';

/**
 * In-memory stand-in for the handful of Db operations snapshotReplay uses. Records what was written
 * so the assertions can read the snapshot the way a restore would.
 */
function memDb(seed: Record<string, any[]>, dbName = 'marshal_1m') {
  const store: Record<string, any[]> = { ...seed };
  const at = (n: string) => (store[n] ??= []);
  return {
    databaseName: dbName,
    store,
    collection(name: string) {
      return {
        find: () => ({ toArray: async () => [...at(name)] }),
        async findOne(_f: any, _o: any) { return at(name)[0] ?? null; },
        async deleteMany() { store[name] = []; },
        async insertMany(docs: any[]) { at(name).push(...docs); },
        async insertOne(doc: any) { at(name).push(doc); },
        async countDocuments(filter: any = {}) {
          const want = filter?.status?.$in as string[] | undefined;
          return want ? at(name).filter(d => want.includes(d.status)).length : at(name).length;
        },
      } as any;
    },
  } as any;
}

describe('recordingSource', () => {
  it('reads working collections in live mode', () => {
    expect(recordingSource(false)).toEqual({
      events: 'agent_events', analysis: 'case_analysis', reviews: 'reviews', audit: 'audit_trail',
    });
  });
  it('reads the immutable replay copies in demo mode', () => {
    expect(recordingSource(true)).toEqual({
      events: 'replay_events', analysis: 'replay_analysis', reviews: 'replay_reviews', audit: 'replay_audit',
    });
  });
  it('maps every working recording collection to a distinct replay copy', () => {
    const copies = Object.values(REPLAY_COLLECTIONS);
    expect(new Set(copies).size).toBe(RECORDING_COLLECTIONS.length);
    // A replay copy must never collide with a working collection name (that would defeat isolation).
    for (const c of copies) expect(RECORDING_COLLECTIONS).not.toContain(c);
  });
});

describe('snapshotReplay — the recording carries its own scale', () => {
  const corpus = [
    { transaction_id: 'a', status: 'approved' }, { transaction_id: 'b', status: 'rejected' },
    { transaction_id: 'c', status: 'escalated' }, { transaction_id: 'd', status: 'pending' },
    { transaction_id: 'e', status: 'review' },
  ];

  it('records the source corpus size and decided count alongside the copies', async () => {
    const db = memDb({ [TRANSACTIONS_COLLECTION]: corpus, agent_events: [{ _id: 1 }] });

    const counts = await snapshotReplay(db);

    const meta = await readReplayMeta(db);
    expect(meta).toMatchObject({ corpus_size: 5, decided_precedents: 3, source_db: 'marshal_1m' });
    // Reported in the bake summary like every other collection, so an operator sees it was written.
    expect(counts[REPLAY_META_COLLECTION]).toBe(1);
    expect(counts[REPLAY_COLLECTIONS.agent_events]).toBe(1);
  });

  it('counts decided precedents with the same predicate the live stats use', async () => {
    // `pending` and `review` are undecided; anything else would make the recorded and live figures
    // two different measurements presented as one number.
    const db = memDb({ [TRANSACTIONS_COLLECTION]: corpus });
    await snapshotReplay(db);
    expect((await readReplayMeta(db))!.decided_precedents).toBe(3);
  });

  it('overwrites the previous provenance rather than accumulating one doc per bake', async () => {
    const db = memDb({ [TRANSACTIONS_COLLECTION]: corpus });
    await snapshotReplay(db);
    db.store[TRANSACTIONS_COLLECTION] = corpus.slice(0, 2);

    await snapshotReplay(db);

    expect(db.store[REPLAY_META_COLLECTION]).toHaveLength(1);
    expect((await readReplayMeta(db))!.corpus_size).toBe(2);
  });
});

describe('readReplayMeta', () => {
  it('returns null when the artifact predates the provenance doc', async () => {
    expect(await readReplayMeta(memDb({}))).toBeNull();
  });

  it('returns null rather than a bad number when corpus_size is not finite', async () => {
    // A hand-edited or half-restored doc must fall back to the live count, not publish NaN as a claim.
    const db = memDb({ [REPLAY_META_COLLECTION]: [{ corpus_size: null, source_db: 'x' }] });
    expect(await readReplayMeta(db)).toBeNull();
  });

  it('returns null instead of throwing when the read fails', async () => {
    const db = { collection: () => ({ findOne: () => Promise.reject(new Error('not authorized')) }) } as any;
    expect(await readReplayMeta(db)).toBeNull();
  });
});
