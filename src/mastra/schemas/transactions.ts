import { z } from 'zod';

/** The three terminal statuses. Precedent retrieval filters to this set so a case can only
 *  cite an already-decided case as precedent. Single source of truth — import, never re-list. */
export const DECIDED_STATUSES = ['approved', 'rejected', 'escalated'] as const;
export type DecidedStatus = (typeof DECIDED_STATUSES)[number];

/** Ground-truth scenario labels. Double as eval labels (Plan 7) and demo fixtures. */
export const LANES = [
  'clean_approve', 'clear_reject', 'structuring', 'high_value', 'ring', 'sanctions',
] as const;
export type Lane = (typeof LANES)[number];

export const TRANSACTIONS_COLLECTION = 'transactions';
export const TRANSACTIONS_VECTOR_INDEX = 'transactions_vector_index';
export const TRANSACTIONS_SEARCH_INDEX = 'transactions_search_index';

export const EMBED_DIM = 1024;

const PartySchema = z.object({
  name: z.string().min(1),
  account_number: z.string().min(1),
});

export const TransactionSchema = z.object({
  transaction_id: z.string().min(1),
  text: z.string().min(1),
  amount: z.number().nonnegative(),
  currency: z.string().length(3),
  sender: PartySchema,
  recipient: PartySchema,
  status: z.enum(['pending', ...DECIDED_STATUSES]),
  lane: z.enum(LANES),
  // 'historical' marks the seed precedent corpus; 'live' marks cases created during a run.
  model_used: z.enum(['historical', 'live']),
  embedding: z.array(z.number()).length(EMBED_DIM),
  created_at: z.date(),
});

export type Transaction = z.infer<typeof TransactionSchema>;
