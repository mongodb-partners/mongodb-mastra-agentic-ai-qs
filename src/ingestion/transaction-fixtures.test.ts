import { describe, it, expect } from 'vitest';
import { loadTransactionSeed, EXPECTED_DISPOSITION } from './transaction-fixtures';
import { LANES, TransactionSchema } from '../mastra/schemas/transactions';

describe('transaction seed corpus', () => {
  const seed = loadTransactionSeed();

  it('covers every lane at least twice (precedent + a live-review case)', () => {
    for (const lane of LANES) {
      const n = seed.filter(s => s.lane === lane).length;
      expect(n, `lane ${lane}`).toBeGreaterThanOrEqual(2);
    }
  });

  it('every record validates against the schema when an embedding is attached', () => {
    for (const rec of seed) {
      const withEmbed = { ...rec, embedding: Array.from({ length: 1024 }, () => 0) };
      expect(() => TransactionSchema.parse(withEmbed), rec.transaction_id).not.toThrow();
    }
  });

  it('has unique transaction_ids', () => {
    const ids = seed.map(s => s.transaction_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('includes exactly one live-review case per lane (model_used=live, status=pending)', () => {
    for (const lane of LANES) {
      const live = seed.filter(s => s.lane === lane && s.model_used === 'live');
      expect(live.length, `live case for ${lane}`).toBe(1);
      expect(live[0].status).toBe('pending');
    }
  });

  it('every historical precedent has a decided status', () => {
    for (const rec of seed.filter(s => s.model_used === 'historical')) {
      expect(['approved', 'rejected', 'escalated'], rec.transaction_id).toContain(rec.status);
    }
  });

  it('maps every lane to an expected disposition', () => {
    for (const lane of LANES) expect(EXPECTED_DISPOSITION[lane]).toBeDefined();
  });

  it('has a ring lane whose sender/recipient accounts form a closable cycle', () => {
    const ring = seed.filter(s => s.lane === 'ring');
    const senders = new Set(ring.map(r => r.sender.account_number));
    const recipients = ring.map(r => r.recipient.account_number);
    expect(recipients.some(r => senders.has(r))).toBe(true);
  });
});
