import { describe, it, expect, vi } from 'vitest';
import { seedTransactions, countDecidedPrecedents } from './seed-transactions';

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
