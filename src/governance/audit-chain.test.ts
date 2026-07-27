import { describe, it, expect } from 'vitest';
import {
  canonicalize, computeHash, buildAuditRecord, hmacKeyId, verifyChain, GENESIS_HASH,
  type AuditEvent, type AuditRecord,
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

describe('hmac_key_id — which key signed this, not how many times it was re-signed', () => {
  it('is stable for one key and distinct across keys', () => {
    expect(hmacKeyId(SECRET)).toBe(hmacKeyId(SECRET));
    expect(hmacKeyId(SECRET)).not.toBe(hmacKeyId(`${SECRET}-other`));
    // 12 hex chars: long enough that two operator-chosen keys will not collide in practice, short
    // enough to read off a record at a glance.
    expect(hmacKeyId(SECRET)).toMatch(/^[0-9a-f]{12}$/);
  });

  it('never reveals the secret it fingerprints', () => {
    // A one-way function of the key, so it is safe to store beside the events — the same property
    // that lets current_hash sit in the record.
    expect(hmacKeyId(SECRET)).not.toContain(SECRET);
    expect(hmacKeyId('')).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is derived from the signing secret, so a record can never mislabel its own key', () => {
    const r = buildAuditRecord(SECRET, GENESIS_HASH, ev());
    expect(r.hmac_key_id).toBe(hmacKeyId(SECRET));
  });

  it('reports key_mismatch — not hmac_mismatch — when the chain was signed by another key', () => {
    // This is the operational payoff. Both are failures, but they call for opposite responses:
    // key_mismatch means re-sign or point at the right secret; hmac_mismatch means the content
    // changed under a key that still matches, i.e. investigate. The "AUDIT CHAIN BROKEN" banner
    // after a seed without AUDIT_SECRET is the former, and used to be indistinguishable.
    const r1 = buildAuditRecord(SECRET, GENESIS_HASH, ev({ entity_id: 'a' }));
    const r2 = buildAuditRecord(SECRET, r1.current_hash, ev({ entity_id: 'b' }));

    const v = verifyChain('a-different-secret', [r1, r2]);

    expect(v.ok).toBe(false);
    expect(v.brokenLinks.map(b => b.reason)).toEqual(['key_mismatch', 'key_mismatch']);
  });

  it('falls back to hmac_mismatch for a record that names no key at all', () => {
    // Pre-migration records carry no id. Absence is not evidence of a key problem, and reporting one
    // would send an operator to rotate a key over real tampering.
    const r = buildAuditRecord(SECRET, GENESIS_HASH, ev());
    const legacy = { ...r, hmac_key_id: undefined } as unknown as AuditRecord;

    expect(verifyChain('a-different-secret', [legacy]).brokenLinks)
      .toEqual([{ index: 0, reason: 'hmac_mismatch' }]);
  });
});
