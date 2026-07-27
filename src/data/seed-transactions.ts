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
 * Above this many surplus documents, a shrink is treated as a mistake unless explicitly allowed.
 * See the `allowShrink` discussion in `seedSyntheticCorpus`.
 */
export const SHRINK_GUARD_THRESHOLD = 1000;

/**
 * Seed the synthetic decided-precedent corpus up to `count` documents. Idempotent and
 * incremental: only missing ids are embedded and inserted (re-provisioning is cheap), and
 * shrinking `count` removes the surplus. Returns how many were written and the final total.
 *
 * **The shrink path is guarded.** Both the app corpus and the benchmark corpus use the same
 * `SYNTHETIC_ID_PREFIX`, so "surplus" is every `txn-syn-*` document outside the wanted `count` —
 * regardless of which process wrote it. Running this against the 1M database at the old default of
 * `SEED_SCALE_COUNT=1200` therefore computes ~998,800 surplus ids and deletes them, silently and
 * successfully, in what reads as a routine re-provision. That is a ~1.4 h re-seed to undo.
 *
 * A shrink of more than `SHRINK_GUARD_THRESHOLD` documents now throws instead, naming the count
 * and how to proceed. Deliberate shrinks pass `allowShrink: true`. Small shrinks (the ordinary
 * "I lowered SEED_SCALE_COUNT" case) are unaffected, so the guard costs nothing in normal use.
 */
export async function seedSyntheticCorpus(
  col: Collection<Transaction>, embed: EmbedFn, count: number,
  opts: { allowShrink?: boolean } = {},
): Promise<{ written: number; removed: number; total: number }> {
  const idFilter = { transaction_id: { $regex: `^${SYNTHETIC_ID_PREFIX}` } };
  const wanted = generateSyntheticCorpus(count);
  const wantedIds = new Set(wanted.map(r => r.transaction_id));
  const existing = new Set(
    (await col.find(idFilter as any, { projection: { transaction_id: 1 } }).toArray())
      .map(d => d.transaction_id as string),
  );

  const surplus = [...existing].filter(id => !wantedIds.has(id));
  if (surplus.length > SHRINK_GUARD_THRESHOLD && !opts.allowShrink) {
    throw new Error(
      `refusing to delete ${surplus.length} synthetic transactions: SEED_SCALE_COUNT=${count} is ` +
      `far below the ${existing.size} '${SYNTHETIC_ID_PREFIX}' documents already present. This is ` +
      'the shape of a re-provision run against a large corpus with a small default — it would ' +
      'destroy the corpus. Set SEED_SCALE_COUNT=0 to leave the corpus alone, or pass ' +
      'allowShrink to shrink it on purpose.',
    );
  }
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
