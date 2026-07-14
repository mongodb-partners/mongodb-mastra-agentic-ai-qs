import type { Collection } from 'mongodb';
import type { Transaction } from '../mastra/schemas/transactions';
import { DECIDED_STATUSES } from '../mastra/schemas/transactions';
import { loadTransactionSeed } from '../ingestion/transaction-fixtures';
import { generateSyntheticCorpus, SYNTHETIC_ID_PREFIX } from './synthetic-corpus';

export type EmbedFn = (texts: string[]) => Promise<number[][]>;

/** Embed each seed record's narrative and upsert by transaction_id. Idempotent. Returns count. */
export async function seedTransactions(
  col: Collection<Transaction>, embed: EmbedFn,
): Promise<number> {
  const records = loadTransactionSeed();
  const vectors = await embed(records.map(r => r.text));
  let n = 0;
  for (let i = 0; i < records.length; i++) {
    const doc = { ...records[i], embedding: vectors[i] } as Transaction;
    await col.replaceOne({ transaction_id: doc.transaction_id }, doc, { upsert: true });
    n++;
  }
  return n;
}

export async function countDecidedPrecedents(col: Collection<Transaction>): Promise<number> {
  return col.countDocuments({ status: { $in: [...DECIDED_STATUSES] } });
}

/**
 * Seed the synthetic decided-precedent corpus up to `count` documents. Idempotent and
 * incremental: only missing ids are embedded and inserted (re-provisioning is cheap), and
 * shrinking `count` removes the surplus. Returns how many were written and the final total.
 */
export async function seedSyntheticCorpus(
  col: Collection<Transaction>, embed: EmbedFn, count: number,
): Promise<{ written: number; removed: number; total: number }> {
  const idFilter = { transaction_id: { $regex: `^${SYNTHETIC_ID_PREFIX}` } };
  const wanted = generateSyntheticCorpus(count);
  const wantedIds = new Set(wanted.map(r => r.transaction_id));
  const existing = new Set(
    (await col.find(idFilter as any, { projection: { transaction_id: 1 } }).toArray())
      .map(d => d.transaction_id as string),
  );

  const surplus = [...existing].filter(id => !wantedIds.has(id));
  if (surplus.length) await col.deleteMany({ transaction_id: { $in: surplus } } as any);

  const missing = wanted.filter(r => !existing.has(r.transaction_id));
  const INSERT_CHUNK = 200;
  let written = 0;
  for (let i = 0; i < missing.length; i += INSERT_CHUNK) {
    const chunk = missing.slice(i, i + INSERT_CHUNK);
    const vectors = await embed(chunk.map(r => r.text));
    await col.insertMany(chunk.map((r, j) => ({ ...r, embedding: vectors[j] } as Transaction)));
    written += chunk.length;
  }
  return { written, removed: surplus.length, total: count };
}
