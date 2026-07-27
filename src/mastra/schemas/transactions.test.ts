import { describe, it, expect } from 'vitest';
import { Decimal128 } from 'mongodb';
import {
  TransactionSchema, MoneySchema, DECIDED_STATUSES, LANES, EMBED_DIM,
  TRANSACTIONS_COLLECTION, TRANSACTIONS_VECTOR_INDEX, TRANSACTIONS_SEARCH_INDEX,
} from './transactions';
import { toBinData } from '../../data/embedding-codec';

const valid = {
  transaction_id: 'txn-0001',
  text: 'Cash deposit of 4950 USD just under the 5000 reporting threshold.',
  amount: 4950,
  currency: 'USD',
  sender: { name: 'Acme LLC', account_number: 'ACC-1001' },
  recipient: { name: 'Beta Inc', account_number: 'ACC-2002' },
  status: 'pending',
  lane: 'structuring',
  model_used: 'historical',
  embedding: Array.from({ length: 1024 }, () => 0),
  created_at: new Date('2026-06-01T00:00:00Z'),
};

describe('TransactionSchema', () => {
  it('accepts a valid transaction', () => {
    expect(() => TransactionSchema.parse(valid)).not.toThrow();
  });
  it('rejects an embedding that is not 1024-dim', () => {
    expect(() => TransactionSchema.parse({ ...valid, embedding: [0, 0, 0] })).toThrow();
  });
  it('accepts a float32 BinData embedding, the storage form at 1M scale', () => {
    const bin = toBinData(Array.from({ length: EMBED_DIM }, () => 0.1));
    expect(() => TransactionSchema.parse({ ...valid, embedding: bin })).not.toThrow();
  });
  it('rejects a BinData embedding of the wrong byte length', () => {
    // Widening to accept Binary must not become "accept any Binary" — a 512-dim vector written
    // against a 1024-dim index returns no error, just wrong neighbours, so catch it at the schema.
    const short = toBinData(Array.from({ length: EMBED_DIM / 2 }, () => 0.1));
    expect(() => TransactionSchema.parse({ ...valid, embedding: short })).toThrow();
  });
  it('rejects an unknown status', () => {
    expect(() => TransactionSchema.parse({ ...valid, status: 'frozen' })).toThrow();
  });
  it('rejects an unknown lane', () => {
    expect(() => TransactionSchema.parse({ ...valid, lane: 'made_up' })).toThrow();
  });
  it('exposes the decided-status single source of truth', () => {
    expect(DECIDED_STATUSES).toEqual(['approved', 'rejected', 'escalated']);
  });
  it('exposes all six lanes and the collection/index names', () => {
    expect(LANES).toHaveLength(6);
    expect(TRANSACTIONS_COLLECTION).toBe('transactions');
    expect(TRANSACTIONS_VECTOR_INDEX).toBe('transactions_vector_index');
    expect(TRANSACTIONS_SEARCH_INDEX).toBe('transactions_search_index');
  });
});

describe('MoneySchema', () => {
  it('accepts a Decimal128', () => {
    // z.number() REJECTS a Decimal128 (safeParse().success === false) with no useful message.
    // Without the union, every document read from the migrated collection fails validation.
    expect(MoneySchema.safeParse(Decimal128.fromString('4950.00')).success).toBe(true);
  });

  it('still accepts a plain number, so pre-migration documents validate', () => {
    expect(MoneySchema.safeParse(4950).success).toBe(true);
  });

  it('rejects a negative amount in either representation', () => {
    expect(MoneySchema.safeParse(-1).success).toBe(false);
    expect(MoneySchema.safeParse(Decimal128.fromString('-1.00')).success).toBe(false);
  });

  it('rejects a non-numeric Decimal128', () => {
    expect(MoneySchema.safeParse(Decimal128.fromString('NaN')).success).toBe(false);
  });

  it('rejects the extended-JSON object form, which is not a Decimal128', () => {
    // What JSON.parse(JSON.stringify(decimal128)) produces. It must not validate, or a
    // round-tripped payload would be stored as a plain sub-document.
    expect(MoneySchema.safeParse({ $numberDecimal: '4950.00' }).success).toBe(false);
  });
});

describe('TransactionSchema amount', () => {
  it('validates a document whose amount is a Decimal128', () => {
    expect(TransactionSchema.safeParse({ ...valid, amount: Decimal128.fromString('4950.00') }).success).toBe(true);
  });
});
