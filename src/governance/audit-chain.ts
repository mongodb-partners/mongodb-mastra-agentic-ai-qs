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
  hmac_key_version: number;
}

/** Canonical JSON: keys sorted recursively so the hash is deterministic regardless of key order. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

/** currentHash = HMAC(secret, previousHash + canonicalJSON(event)). */
export function computeHash(secret: string, previousHash: string, event: AuditEvent): string {
  const payload = previousHash + canonicalize({ ...event, timestamp: event.timestamp.toISOString() });
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/** Build the next chained record given the prior record's hash. */
export function buildAuditRecord(
  secret: string, previousHash: string, event: AuditEvent, keyVersion = 1,
): AuditRecord {
  return {
    ...event,
    previous_hash: previousHash,
    current_hash: computeHash(secret, previousHash, event),
    hmac_key_version: keyVersion,
  };
}

export interface ChainVerification { ok: boolean; brokenLinks: { index: number; reason: string }[]; }

/** Recompute every link over an ordered slice and report tampering. */
export function verifyChain(secret: string, records: AuditRecord[]): ChainVerification {
  const broken: { index: number; reason: string }[] = [];
  let expectedPrev = GENESIS_HASH;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.previous_hash !== expectedPrev) broken.push({ index: i, reason: 'chain_link_broken' });
    const recomputed = computeHash(secret, r.previous_hash, {
      event_type: r.event_type, entity_id: r.entity_id, actor: r.actor,
      payload_summary: r.payload_summary, timestamp: r.timestamp,
    });
    if (recomputed !== r.current_hash) broken.push({ index: i, reason: 'hmac_mismatch' });
    expectedPrev = r.current_hash;
  }
  return { ok: broken.length === 0, brokenLinks: broken };
}
