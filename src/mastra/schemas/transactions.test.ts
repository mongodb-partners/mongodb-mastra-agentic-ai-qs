import { describe, it, expect } from 'vitest';
import {
  TransactionSchema, DECIDED_STATUSES, LANES,
  TRANSACTIONS_COLLECTION, TRANSACTIONS_VECTOR_INDEX, TRANSACTIONS_SEARCH_INDEX,
} from './transactions';

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
