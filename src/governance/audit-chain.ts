import { createHmac } from 'node:crypto';

/** The genesis previous-hash for a fresh chain. */
export const GENESIS_HASH = '0'.repeat(64);

export interface AuditEvent {
  event_type: string;
  entity_id: string;               // e.g. the transaction/case id
  actor: { type: 'agent' | 'human' | 'system'; id: string };
  // Payload SHAPE only — never raw PII. e.g. field names touched, counts.
  payload_summary: Record<string, unknown>;
  timestamp: Date;
}

export interface AuditRecord extends AuditEvent {
  previous_hash: string;
  current_hash: string;
  /**
   * Short fingerprint OF THE KEY that produced `current_hash` — not a version counter.
   *
   * A monotonic counter cannot answer the only question this field exists to answer: "which key
   * signed this record?" It was previously `(prior ?? 1) + 1` per re-sign, i.e. a count of how many
   * times a chain had been re-signed, which makes two boxes holding the SAME key report different
   * values (each re-signed a different number of times) and two boxes holding DIFFERENT keys report
   * the same value (both re-signed once). That is exactly inverted from what an operator needs when
   * a chain reads broken: `hmac_key_id` differing from what the running config derives is a key
   * mismatch, and equal means the content really was tampered with. See `marshal-audit-secret-seed-trap`.
   *
   * Derived, never stored input: HMAC(secret, KEY_ID_LABEL) truncated to 12 hex chars. It is a
   * one-way function of the secret, so publishing it in a record leaks nothing usable — the same
   * property that lets `current_hash` sit next to the event it signs.
   */
  hmac_key_id: string;
}

/** Canonical JSON: keys sorted recursively so the hash is deterministic regardless of key order. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

/**
 * Domain-separation label for the key fingerprint. Fixed and distinct from any chain payload, so a
 * fingerprint can never collide with a record hash: `computeHash` always prefixes a 64-char hex
 * previous_hash, which this is not.
 */
const KEY_ID_LABEL = 'marshal-audit-key-id/v1';

/**
 * Stable 12-hex-char fingerprint of an HMAC secret. Same key ⇒ same id on every box, in every
 * process, forever; different key ⇒ different id. Truncation is safe here because this is an
 * equality label for humans reading a record, not a security boundary — forging a matching id
 * requires the secret, and matching it buys nothing, since `verifyChain` ignores this field and
 * recomputes every HMAC from the configured secret.
 */
export function hmacKeyId(secret: string): string {
  return createHmac('sha256', secret).update(KEY_ID_LABEL).digest('hex').slice(0, 12);
}

/** currentHash = HMAC(secret, previousHash + canonicalJSON(event)). */
export function computeHash(secret: string, previousHash: string, event: AuditEvent): string {
  const payload = previousHash + canonicalize({ ...event, timestamp: event.timestamp.toISOString() });
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Build the next chained record given the prior record's hash.
 *
 * The key id is DERIVED from the same secret that computes the hash, not passed in: the two can then
 * never disagree, which is the failure a caller-supplied version number invites.
 */
export function buildAuditRecord(
  secret: string, previousHash: string, event: AuditEvent,
): AuditRecord {
  return {
    ...event,
    previous_hash: previousHash,
    current_hash: computeHash(secret, previousHash, event),
    hmac_key_id: hmacKeyId(secret),
  };
}

export interface ChainVerification { ok: boolean; brokenLinks: { index: number; reason: string }[]; }

/**
 * Recompute every link over an ordered slice and report tampering.
 *
 * A failed link is reported as `key_mismatch` rather than `hmac_mismatch` when the record names a
 * different key than the one being verified with. Both are still failures — this never flips `ok` —
 * but they call for opposite responses: `key_mismatch` means re-sign (or point at the right secret),
 * `hmac_mismatch` means the content changed under a key that still matches, i.e. real tampering.
 * Distinguishing them is the whole reason `hmac_key_id` is on the record.
 */
export function verifyChain(secret: string, records: AuditRecord[]): ChainVerification {
  const broken: { index: number; reason: string }[] = [];
  const expectedKeyId = hmacKeyId(secret);
  let expectedPrev = GENESIS_HASH;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.previous_hash !== expectedPrev) broken.push({ index: i, reason: 'chain_link_broken' });
    const recomputed = computeHash(secret, r.previous_hash, {
      event_type: r.event_type, entity_id: r.entity_id, actor: r.actor,
      payload_summary: r.payload_summary, timestamp: r.timestamp,
    });
    if (recomputed !== r.current_hash) {
      // Only claim a key mismatch when the record actually names a key. A record predating this
      // field (or one whose id was stripped) must not be reported as a key problem on the strength
      // of an absent value — that would send an operator to rotate a key over real tampering.
      const named = typeof r.hmac_key_id === 'string' && r.hmac_key_id.length > 0;
      broken.push({ index: i, reason: named && r.hmac_key_id !== expectedKeyId ? 'key_mismatch' : 'hmac_mismatch' });
    }
    expectedPrev = r.current_hash;
  }
  return { ok: broken.length === 0, brokenLinks: broken };
}
