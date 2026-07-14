import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Transaction, Lane } from '../mastra/schemas/transactions';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Seed record shape: a Transaction minus the embedding (attached at seed time) with an
 *  ISO date string for created_at (coerced to a Date here). */
type SeedRecord = Omit<Transaction, 'embedding' | 'created_at'> & { created_at: string };

export function loadTransactionSeed(): Omit<Transaction, 'embedding'>[] {
  const raw = readFileSync(join(HERE, 'data', 'transactions.seed.json'), 'utf8');
  const records = JSON.parse(raw) as SeedRecord[];
  return records.map(r => ({ ...r, created_at: new Date(r.created_at) }));
}

export const EXPECTED_DISPOSITION: Record<Lane, 'approve' | 'reject' | 'escalate'> = {
  clean_approve: 'approve',
  clear_reject: 'reject',
  structuring: 'escalate',
  high_value: 'escalate',
  ring: 'escalate',
  sanctions: 'reject',
};
