import { describe, it, expect } from 'vitest';
import { generateSyntheticCorpus, SYNTHETIC_ID_PREFIX } from './synthetic-corpus';
import { DECIDED_STATUSES, LANES, TransactionSchema } from '../mastra/schemas/transactions';

describe('generateSyntheticCorpus', () => {
  it('is deterministic for the same count and seed', () => {
    const a = generateSyntheticCorpus(300);
    const b = generateSyntheticCorpus(300);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('is a strict prefix when count grows (incremental seeding stays idempotent)', () => {
    const small = generateSyntheticCorpus(200);
    const large = generateSyntheticCorpus(500);
    expect(JSON.stringify(large.slice(0, 200))).toBe(JSON.stringify(small));
  });

  it('produces unique, prefixed ids and only DECIDED statuses (never pending)', () => {
    const corpus = generateSyntheticCorpus(500);
    const ids = new Set(corpus.map(r => r.transaction_id));
    expect(ids.size).toBe(500);
    for (const r of corpus) {
      expect(r.transaction_id.startsWith(SYNTHETIC_ID_PREFIX)).toBe(true);
      expect(DECIDED_STATUSES).toContain(r.status);
      expect(r.model_used).toBe('historical');
    }
  });

  it('covers every lane and skews toward clean traffic', () => {
    const corpus = generateSyntheticCorpus(1200);
    const byLane = new Map<string, number>();
    for (const r of corpus) byLane.set(r.lane, (byLane.get(r.lane) ?? 0) + 1);
    for (const lane of LANES) expect(byLane.get(lane) ?? 0).toBeGreaterThan(0);
    expect(byLane.get('clean_approve')! / corpus.length).toBeGreaterThan(0.4);
  });

  it('gives ring transactions genuine 3-account cycles for $graphLookup', () => {
    const corpus = generateSyntheticCorpus(1200);
    const ring = corpus.filter(r => r.lane === 'ring');
    expect(ring.length).toBeGreaterThanOrEqual(3);
    // Every ring account appears as both a sender and a recipient within the corpus (a cycle).
    const senders = new Set(ring.map(r => r.sender.account_number));
    const recipients = new Set(ring.map(r => r.recipient.account_number));
    const firstGroup = ring.filter(r => /^ACC-SYNRING-1[ABC]$/.test(r.sender.account_number));
    expect(firstGroup.length).toBe(3);
    for (const r of firstGroup) {
      expect(senders.has(r.recipient.account_number) || recipients.has(r.sender.account_number)).toBe(true);
    }
  });

  it('predates the curated seeds so demo cases sort first in the queue', () => {
    const corpus = generateSyntheticCorpus(300);
    const cutoff = Date.UTC(2026, 4, 1); // curated seeds start 2026-05
    for (const r of corpus) expect(r.created_at.getTime()).toBeLessThan(cutoff);
  });

  it('validates against the Transaction schema (minus embedding)', () => {
    const corpus = generateSyntheticCorpus(50);
    for (const r of corpus) {
      TransactionSchema.omit({ embedding: true }).parse(r);
    }
  });
});
