import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Transaction, Lane } from '../mastra/schemas/transactions';
import { toMoney } from '../money';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Seed record shape as it appears in JSON: a Transaction minus the embedding (attached at seed
 *  time), with an ISO date string for created_at and a plain-number amount (both coerced here). */
type SeedRecord = Omit<Transaction, 'embedding' | 'created_at' | 'amount'> & {
  created_at: string;
  amount: number;
};

export function loadTransactionSeed(): Omit<Transaction, 'embedding'>[] {
  const raw = readFileSync(join(HERE, 'data', 'transactions.seed.json'), 'utf8');
  const records = JSON.parse(raw) as SeedRecord[];
  // The JSON literals stay plain numbers — the file is human-edited and a `{"$numberDecimal":...}`
  // literal there would be a worse thing to maintain than a coercion here.
  return records.map(r => ({ ...r, amount: toMoney(r.amount), created_at: new Date(r.created_at) }));
}

export const EXPECTED_DISPOSITION: Record<Lane, 'approve' | 'reject' | 'escalate'> = {
  clean_approve: 'approve',
  clear_reject: 'reject',
  structuring: 'escalate',
  high_value: 'escalate',
  ring: 'escalate',
  sanctions: 'reject',
};
