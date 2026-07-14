import { describe, it, expect } from 'vitest';
import {
  canonicalize, computeHash, buildAuditRecord, verifyChain, GENESIS_HASH, type AuditEvent,
} from './audit-chain';

const SECRET = 'test-secret';
const ev = (over: Partial<AuditEvent> = {}): AuditEvent => ({
  event_type: 'decision_recorded',
  entity_id: 'txn-1',
  actor: { type: 'agent', id: 'investigation-agent' },
  payload_summary: { fields: ['disposition', 'confidence'], count: 2 },
  timestamp: new Date('2026-06-11T00:00:00Z'),
  ...over,
});

describe('canonicalize', () => {
  it('is order-independent for object keys', () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });
  it('differs when a value differs', () => {
    expect(canonicalize({ a: 1 })).not.toBe(canonicalize({ a: 2 }));
  });
});

describe('hash chain', () => {
  it('computeHash is deterministic', () => {
    expect(computeHash(SECRET, GENESIS_HASH, ev())).toBe(computeHash(SECRET, GENESIS_HASH, ev()));
  });

  it('a well-formed chain verifies', () => {
    const r1 = buildAuditRecord(SECRET, GENESIS_HASH, ev({ entity_id: 'a' }));
    const r2 = buildAuditRecord(SECRET, r1.current_hash, ev({ entity_id: 'b' }));
    const r3 = buildAuditRecord(SECRET, r2.current_hash, ev({ entity_id: 'c' }));
    const v = verifyChain(SECRET, [r1, r2, r3]);
    expect(v.ok).toBe(true);
    expect(v.brokenLinks).toHaveLength(0);
  });

  it('detects a tampered payload (hmac_mismatch)', () => {
    const r1 = buildAuditRecord(SECRET, GENESIS_HASH, ev({ entity_id: 'a' }));
    const r2 = buildAuditRecord(SECRET, r1.current_hash, ev({ entity_id: 'b' }));
    // Tamper: mutate a stored field without recomputing the hash.
    (r2 as any).payload_summary = { fields: ['HACKED'], count: 1 };
    const v = verifyChain(SECRET, [r1, r2]);
    expect(v.ok).toBe(false);
    expect(v.brokenLinks.some(b => b.reason === 'hmac_mismatch')).toBe(true);
  });

  it('detects a broken link (reordered / missing record)', () => {
    const r1 = buildAuditRecord(SECRET, GENESIS_HASH, ev({ entity_id: 'a' }));
    const r2 = buildAuditRecord(SECRET, r1.current_hash, ev({ entity_id: 'b' }));
    const r3 = buildAuditRecord(SECRET, r2.current_hash, ev({ entity_id: 'c' }));
    // Drop r2 -> r3.previous_hash no longer matches the preceding record.
    const v = verifyChain(SECRET, [r1, r3]);
    expect(v.ok).toBe(false);
    expect(v.brokenLinks.some(b => b.reason === 'chain_link_broken')).toBe(true);
  });
});
