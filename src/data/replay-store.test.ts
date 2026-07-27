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
        async countDocuments(filter: any = {}) {
          const want = filter?.status?.$in as string[] | undefined;
          // `$nin` on transaction_id is how snapshotReplay excludes the cases the recording covers,
          // so the stand-in has to honour it — otherwise the test that pins the count passes for the
          // wrong reason.
          const excluded = filter?.transaction_id?.$nin as string[] | undefined;
          return at(name).filter(d =>
            (!want || want.includes(d.status)) &&
            (!excluded || !excluded.includes(d.transaction_id))).length;
        },
        async findOne(_f: any, _o: any) { return at(name)[0] ?? null; },
        async deleteMany() { store[name] = []; },
        async insertMany(docs: any[]) { at(name).push(...docs); },
        async insertOne(doc: any) { at(name).push(doc); },
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

const PROV = { app_commit: 'abc1234', atlas_tier: 'M30', llm_model: 'claude-haiku-4-5' };

describe('snapshotReplay — the recording carries its own scale', () => {
  const corpus = [
    { transaction_id: 'a', status: 'approved' }, { transaction_id: 'b', status: 'rejected' },
    { transaction_id: 'c', status: 'escalated' }, { transaction_id: 'd', status: 'pending' },
    { transaction_id: 'e', status: 'review' },
  ];

  it('records the source corpus size and decided count alongside the copies', async () => {
    const db = memDb({ [TRANSACTIONS_COLLECTION]: corpus, agent_events: [{ _id: 1 }] });

    const counts = await snapshotReplay(db, PROV);

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
    await snapshotReplay(db, PROV);
    expect((await readReplayMeta(db))!.decided_precedents).toBe(3);
  });

  it('excludes the recorded cases from the decided tally, however they ended', async () => {
    // THE REGRESSION. snapshotReplay runs after the run it freezes, so the pipeline has already
    // written dispositions back to `transactions.status`. Here 'a' and 'b' are cases the recording
    // covers and they have committed (approved/rejected), while 'c' is a third decided document that
    // has nothing to do with the run.
    //
    // A bare decided-count returns 3 and describes the cluster the run LEFT. The corpus the run was
    // performed against had only 'c' decided, because 'a' and 'b' were pending when it started.
    // Shipped, this published 1,000,012 of 1,000,015 for a 6-case recording — a corpus three
    // documents short of accounting for its own queue.
    const db = memDb({
      [TRANSACTIONS_COLLECTION]: [
        { transaction_id: 'a', status: 'approved' },
        { transaction_id: 'b', status: 'rejected' },
        { transaction_id: 'c', status: 'approved' },
      ],
      case_analysis: [{ transaction_id: 'a' }, { transaction_id: 'b' }],
    });

    await snapshotReplay(db, PROV);

    const meta = (await readReplayMeta(db))!;
    expect(meta.decided_precedents).toBe(1);
    // The subtraction a viewer does in front of the status bar. It resolves to the recorded case
    // count here, and on the shipped corpus, because the only undecided documents in either are the
    // cases the recording covers. A corpus that also held unrelated pending documents would leave a
    // larger remainder — still correct, just not equal to the case count. What this pins is that the
    // recorded cases are counted as undecided, which is the state the replay actually depicts.
    expect(meta.corpus_size - meta.decided_precedents).toBe(2);
  });

  it('reads the recorded ids from the replay copy, so it does not depend on bake ordering', async () => {
    // The ids come from `replay_analysis` — written by the loop above, in this same call — rather
    // than from the working `case_analysis`. That matters because a live reset clears the working
    // collections but never the replay copies, so this stays correct on a re-snapshot of an artifact
    // whose source run has since been cleared.
    const db = memDb({
      [TRANSACTIONS_COLLECTION]: [
        { transaction_id: 'a', status: 'escalated' }, { transaction_id: 'b', status: 'approved' },
      ],
      case_analysis: [{ transaction_id: 'a' }],
    });

    await snapshotReplay(db, PROV);

    expect(db.store[REPLAY_COLLECTIONS.case_analysis]).toHaveLength(1);
    expect((await readReplayMeta(db))!.decided_precedents).toBe(1);
  });

  it('falls back to the plain decided count when the recording covers no cases', async () => {
    // An empty `$nin` matches nothing in MongoDB, so building the filter unconditionally would return
    // 0 decided for an empty recording and silently claim the whole corpus was undecided.
    const db = memDb({ [TRANSACTIONS_COLLECTION]: corpus, case_analysis: [] });

    await snapshotReplay(db, PROV);

    expect((await readReplayMeta(db))!.decided_precedents).toBe(3);
  });

  it('stamps the commit, tier and model the run was produced at', async () => {
    // The recording's timings are published as latency_p50_ms and the per-stage tail, so they are
    // performance claims — and a claim whose commit, hardware tier and model are unrecorded cannot be
    // checked. Attributing the 2026-07-27 recording took a `git reflog` on the box and a timestamp
    // match against recorded_at; after that box is replaced it would not have been recoverable.
    const db = memDb({ [TRANSACTIONS_COLLECTION]: corpus });

    await snapshotReplay(db, PROV);

    expect(await readReplayMeta(db)).toMatchObject(PROV);
  });

  it('overwrites the previous provenance rather than accumulating one doc per bake', async () => {
    const db = memDb({ [TRANSACTIONS_COLLECTION]: corpus });
    await snapshotReplay(db, PROV);
    db.store[TRANSACTIONS_COLLECTION] = corpus.slice(0, 2);

    await snapshotReplay(db, { ...PROV, app_commit: 'def5678' });

    expect(db.store[REPLAY_META_COLLECTION]).toHaveLength(1);
    expect((await readReplayMeta(db))!.corpus_size).toBe(2);
    // The provenance is replaced too, not merged with the prior bake's: a doc naming the old commit
    // beside the new corpus size would attribute this recording to code that did not produce it.
    expect((await readReplayMeta(db))!.app_commit).toBe('def5678');
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

  it("reports 'unknown' provenance for an artifact baked before those fields existed", async () => {
    // A restore of the pre-provenance artifact must still hand callers three printable strings.
    // `undefined` renders as a blank in a log line or a status bar, and a blank next to "commit" reads
    // as a value rather than as an absence.
    const db = memDb({ [REPLAY_META_COLLECTION]: [{ corpus_size: 12_015, source_db: 'marshal' }] });

    expect(await readReplayMeta(db)).toMatchObject({
      corpus_size: 12_015, app_commit: 'unknown', atlas_tier: 'unknown', llm_model: 'unknown',
    });
  });

  it('does not overwrite recorded provenance with the defaults', async () => {
    // The spread order is the whole behaviour: defaults first, doc second. Reversed, every restored
    // recording would report 'unknown' no matter what was baked into it.
    const db = memDb({ [REPLAY_META_COLLECTION]: [{ corpus_size: 5, source_db: 'x', ...PROV }] });

    expect(await readReplayMeta(db)).toMatchObject(PROV);
  });
});
