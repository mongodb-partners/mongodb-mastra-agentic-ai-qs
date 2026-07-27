import { z } from 'zod';
import { Binary, Decimal128 } from 'mongodb';

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

/** On-the-wire size of a float32 BSON vector at EMBED_DIM: the payload plus the 2-byte dtype
 *  header. Defined here rather than imported from `data/embedding-codec` (which imports EMBED_DIM
 *  from this file) so the schema layer stays free of a cycle; `vectorByteLength` is the same
 *  arithmetic and the codec test pins both to 4098. */
const VECTOR_BYTES = EMBED_DIM * 4 + 2;

/**
 * A currency field. Decimal128 is the stored type; a plain number is still accepted so documents
 * written before the migration — and the seed fixtures' JSON literals — keep validating.
 *
 * `z.number()` alone does NOT work here: `z.number().safeParse(Decimal128.fromString('1.00'))`
 * is `false`, so a bare number field rejects every migrated document. See src/money.ts.
 */
export const MoneySchema = z.union([
  z.number().nonnegative(),
  z.instanceof(Decimal128).refine(
    d => {
      // Decimal128.fromString accepts 'NaN' and 'Infinity'. Neither is money, and both would
      // otherwise pass an `instanceof` check and land in the database.
      const n = Number(d.toString());
      return Number.isFinite(n) && n >= 0;
    },
    { message: 'amount must be a finite, non-negative Decimal128' },
  ),
]);

const PartySchema = z.object({
  name: z.string().min(1),
  account_number: z.string().min(1),
});

export const TransactionSchema = z.object({
  transaction_id: z.string().min(1),
  text: z.string().min(1),
  amount: MoneySchema,
  currency: z.string().length(3),
  sender: PartySchema,
  recipient: PartySchema,
  status: z.enum(['pending', ...DECIDED_STATUSES]),
  lane: z.enum(LANES),
  // 'historical' marks the seed precedent corpus; 'live' marks cases created during a run.
  model_used: z.enum(['historical', 'live']),
  // Either representation: a BSON array of doubles, or float32 vector BinData (3x smaller — see
  // data/embedding-codec.ts). A collection part-way through the migration holds both. The length
  // check still applies to the ARRAY form, so a wrong-dimension array is still rejected, and the
  // Binary branch checks subtype and byte length rather than accepting any Binary at all: a
  // subtype-0 blob of the right size is silently unsearchable on Atlas, which is the worse failure.
  embedding: z.union([
    z.array(z.number()).length(EMBED_DIM),
    z.instanceof(Binary).refine(
      b => b.sub_type === Binary.SUBTYPE_VECTOR && b.buffer.length === VECTOR_BYTES,
      {
        message: `float32 vector BinData must be subtype ${Binary.SUBTYPE_VECTOR} and ` +
          `${VECTOR_BYTES} bytes (${EMBED_DIM} dims + 2-byte dtype header)`,
      },
    ),
  ]),
  created_at: z.date(),
});

export type Transaction = z.infer<typeof TransactionSchema>;
