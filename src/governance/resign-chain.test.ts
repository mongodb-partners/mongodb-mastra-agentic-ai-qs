import { describe, it, expect } from 'vitest';
import { resignAuditChain, resignRecords } from './resign-chain';
import { buildAuditRecord, verifyChain, GENESIS_HASH, type AuditEvent, type AuditRecord } from './audit-chain';

const OLD = 'marshal-dev-audit-secret';
const NEW = 'a-real-strong-deployment-secret';

const ev = (i: number): AuditEvent => ({
  event_type: 'decision_recorded',
  entity_id: `txn-${i}`,
  actor: { type: 'agent', id: 'investigation-agent' },
  payload_summary: { fields: ['disposition'], disposition: 'reject', risk_factor_count: i },
  timestamp: new Date(Date.UTC(2026, 5, 11, 0, 0, i)),
});

/** A valid 3-record chain under `secret`, exactly as bake + export would produce it. */
function chain(secret: string): AuditRecord[] {
  const out: AuditRecord[] = [];
  let prev = GENESIS_HASH;
  for (let i = 0; i < 3; i++) {
    const rec = buildAuditRecord(secret, prev, ev(i));
    out.push({ ...rec, _id: `id-${i}` } as AuditRecord);
    prev = rec.current_hash;
  }
  return out;
}

/**
 * Minimal in-memory stand-in for the one collection resignAuditChain touches. Keeps insertion order
 * (which is chain order) and applies $set the way bulkWrite would.
 */
function fakeDb(records: AuditRecord[]) {
  const docs = records.map(r => ({ ...r }));
  const coll = {
    find: () => ({ sort: () => ({ toArray: async () => docs.map(d => ({ ...d })) }) }),
    bulkWrite: async (ops: any[]) => {
      for (const op of ops) {
        const doc = docs.find(d => (d as any)._id === op.updateOne.filter._id);
        if (doc) Object.assign(doc, op.updateOne.update.$set);
      }
      return { modifiedCount: ops.length };
    },
  };
  return { db: { collection: () => coll } as any, docs };
}

describe('resignAuditChain', () => {
  it('re-signs a dev-key chain so it verifies under the deployment secret', async () => {
    const { db, docs } = fakeDb(chain(OLD));
    const res = await resignAuditChain(db, 'replay_audit', OLD, NEW);

    expect(res).toMatchObject({ status: 'resigned', records: 3 });
    expect(verifyChain(NEW, docs as AuditRecord[]).ok).toBe(true);
    expect(verifyChain(OLD, docs as AuditRecord[]).ok).toBe(false);
  });

  it('preserves event content — only the hashes and key version move', async () => {
    const before = chain(OLD);
    const { db, docs } = fakeDb(before);
    await resignAuditChain(db, 'replay_audit', OLD, NEW);

    for (const [i, d] of docs.entries()) {
      expect(d.event_type).toBe(before[i].event_type);
      expect(d.entity_id).toBe(before[i].entity_id);
      expect(d.actor).toEqual(before[i].actor);
      expect(d.payload_summary).toEqual(before[i].payload_summary);
      expect(d.timestamp).toEqual(before[i].timestamp);
      expect(d.hmac_key_version).toBe(2);
    }
  });

  it('is a no-op when the chain already verifies under the new secret', async () => {
    const { db, docs } = fakeDb(chain(NEW));
    const snapshot = docs.map(d => ({ ...d }));

    const res = await resignAuditChain(db, 'replay_audit', OLD, NEW);

    expect(res).toMatchObject({ status: 'already_valid', records: 3 });
    expect(docs).toEqual(snapshot);
  });

  it('is idempotent across repeated restores', async () => {
    const { db, docs } = fakeDb(chain(OLD));
    await resignAuditChain(db, 'replay_audit', OLD, NEW);
    const afterFirst = docs.map(d => ({ ...d }));

    const second = await resignAuditChain(db, 'replay_audit', OLD, NEW);

    expect(second.status).toBe('already_valid');
    expect(docs).toEqual(afterFirst);
  });

  it('REFUSES to re-sign tampered content rather than laundering it', async () => {
    const tampered = chain(OLD);
    // Flip a payload value without touching the hash — genuine tampering, not a key rotation.
    tampered[1] = { ...tampered[1], payload_summary: { ...tampered[1].payload_summary, disposition: 'approve' } };
    const { db, docs } = fakeDb(tampered);
    const snapshot = docs.map(d => ({ ...d }));

    const res = await resignAuditChain(db, 'replay_audit', OLD, NEW);

    expect(res.status).toBe('tampered');
    expect(res.brokenLinks?.some(b => b.reason === 'hmac_mismatch')).toBe(true);
    expect(docs).toEqual(snapshot); // nothing written
  });

  it('reports an empty chain instead of failing', async () => {
    const { db } = fakeDb([]);
    expect(await resignAuditChain(db, 'replay_audit', OLD, NEW)).toEqual({ status: 'empty', records: 0 });
  });
});

describe('resignRecords — what export:replay uses to normalize the committed artifact', () => {
  it('rewrites a box-signed chain to the dev key so any box can restore it', () => {
    // The regression this guards: a bake that ran ON a deployed box (forced, because that box's
    // least-privilege user is the only one that can reach its scratch DB) exported a chain signed
    // with THAT box's secret. restore:replay re-signs dev → deployment, so the artifact verified
    // under neither key on the other track and the restore aborted as possible tampering.
    const boxSigned = chain(NEW);
    const out = resignRecords(boxSigned, NEW, OLD)!;

    expect(verifyChain(OLD, out).ok).toBe(true);
    expect(verifyChain(NEW, out).ok).toBe(false);
    // …and the deploy-time re-sign then takes it back to whatever the target box runs with.
    expect(verifyChain(NEW, resignRecords(out, OLD, NEW)!).ok).toBe(true);
  });

  it('never touches event content, and does not mutate its input', () => {
    const input = chain(NEW);
    // structuredClone, not JSON round-trip: `timestamp` is a Date and JSON would stringify it,
    // making the purity check compare a string against a Date.
    const before = structuredClone(input);
    const out = resignRecords(input, NEW, OLD)!;

    expect(input).toEqual(before);   // pure
    for (let i = 0; i < out.length; i++) {
      const { previous_hash: _p, current_hash: _c, hmac_key_version: _v, ...content } = out[i] as any;
      const { previous_hash: _p2, current_hash: _c2, hmac_key_version: _v2, ...was } = before[i] as any;
      expect(content).toEqual(was);
    }
    expect(out.map(r => r.hmac_key_version)).toEqual([2, 2, 2]);
  });

  it('returns null rather than laundering a chain that does not verify under the old key', () => {
    const tampered = chain(NEW);
    tampered[1].payload_summary = { fields: ['disposition'], disposition: 'approve' };
    expect(resignRecords(tampered, NEW, OLD)).toBeNull();
  });
});
