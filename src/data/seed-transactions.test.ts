import { describe, it, expect, vi } from 'vitest';
import {
  seedTransactions, countDecidedPrecedents, seedSyntheticCorpus, SHRINK_GUARD_THRESHOLD,
} from './seed-transactions';
import { SYNTHETIC_ID_PREFIX } from './synthetic-corpus';

// Minimal fake of the Mongo Collection surface these functions use.
function fakeCollection() {
  const store = new Map<string, any>();
  return {
    store,
    async replaceOne(filter: any, doc: any) {
      store.set(filter.transaction_id, doc);
      return { upsertedCount: 1 };
    },
    countDocuments(query: any) {
      const set = query?.status?.$in as string[] | undefined;
      const n = [...store.values()].filter(d => !set || set.includes(d.status)).length;
      return Promise.resolve(n);
    },
  };
}

const fakeEmbed = vi.fn(async (texts: string[]) =>
  texts.map((_, i) => Array.from({ length: 1024 }, () => (i + 1) / 1000)));

describe('seedTransactions', () => {
  it('embeds and writes every seed record, returning the count', async () => {
    const col = fakeCollection();
    const n = await seedTransactions(col as any, fakeEmbed);
    expect(n).toBeGreaterThanOrEqual(14);
    expect(col.store.size).toBe(n);
    for (const doc of col.store.values()) expect(doc.embedding).toHaveLength(1024);
    expect(fakeEmbed).toHaveBeenCalled();
  });

  it('counts only decided precedents', async () => {
    const col = fakeCollection();
    await seedTransactions(col as any, fakeEmbed);
    const decided = await countDecidedPrecedents(col as any);
    expect(decided).toBeGreaterThan(0);
    expect(decided).toBeLessThan(col.store.size);
  });
});

describe('seedSyntheticCorpus shrink guard', () => {
  /** Fake holding `present` synthetic ids, recording what a shrink would delete. */
  function fakeSyntheticCollection(present: number) {
    const deleted: string[] = [];
    const ids = Array.from({ length: present }, (_, i) =>
      `${SYNTHETIC_ID_PREFIX}${String(i + 1).padStart(5, '0')}`);
    return {
      deleted,
      find: () => ({ toArray: async () => ids.map(transaction_id => ({ transaction_id })) }),
      async deleteMany(filter: any) {
        deleted.push(...filter.transaction_id.$in);
        return { deletedCount: filter.transaction_id.$in.length };
      },
      async insertMany() { return { insertedCount: 0 }; },
    };
  }

  it('REFUSES a large shrink and deletes nothing', async () => {
    // The live shape of this bug: the app corpus and the benchmark corpus share
    // SYNTHETIC_ID_PREFIX, so a routine re-provision against a 1M database carrying the old
    // SEED_SCALE_COUNT=1200 computes ~998,800 "surplus" ids and deletes them — successfully,
    // with no error, costing a ~1.4h re-seed.
    const col = fakeSyntheticCollection(5000);
    await expect(seedSyntheticCorpus(col as any, fakeEmbed, 1200)).rejects.toThrow(/refusing to delete/);
    expect(col.deleted).toEqual([]);
  });

  it('names the count and the way out, so the operator does not have to read the source', async () => {
    const col = fakeSyntheticCollection(5000);
    await expect(seedSyntheticCorpus(col as any, fakeEmbed, 1200))
      .rejects.toThrow(/3800[\s\S]*SEED_SCALE_COUNT=0/);
  });

  it('allows a large shrink when asked explicitly', async () => {
    const col = fakeSyntheticCollection(5000);
    const res = await seedSyntheticCorpus(col as any, fakeEmbed, 1200, { allowShrink: true });
    expect(res.removed).toBe(3800);
    expect(col.deleted).toHaveLength(3800);
  });

  it('leaves ordinary small shrinks alone, so the guard costs nothing in normal use', async () => {
    const present = 1200 + SHRINK_GUARD_THRESHOLD;
    const col = fakeSyntheticCollection(present);
    const res = await seedSyntheticCorpus(col as any, fakeEmbed, 1200);
    expect(res.removed).toBe(SHRINK_GUARD_THRESHOLD);
  });
});
