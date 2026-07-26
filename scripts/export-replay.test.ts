import { describe, it, expect, vi } from 'vitest';
import { BSON } from 'mongodb';
import { normalizeAudit, stageExport } from './export-replay';
import { DEV_AUDIT_SECRET } from '../src/config';
import { REPLAY_COLLECTIONS } from '../src/data/replay-store';
import { buildAuditRecord, verifyChain, GENESIS_HASH, type AuditEvent, type AuditRecord } from '../src/governance/audit-chain';

/**
 * These cover the two properties of `pnpm export:replay` that the committed recording depends on and
 * that unit tests of resignRecords() alone could not reach:
 *
 *  1. the artifact is signed with the DEV secret no matter which box baked it, and
 *  2. an export that refuses to run writes NOTHING — not three of four files.
 *
 * Both were found the same way: by running the real script against a scratch cluster. (1) had never
 * executed in any test — only the pure resignRecords() underneath it had. (2) was a live bug that
 * exercise exposed, because replay_audit is last in REPLAY_COLLECTIONS and the abort therefore fired
 * after the other three files were already on disk.
 */

const BOX = 'pretend-this-is-a-deployed-box-secret';

const ev = (i: number): AuditEvent => ({
  event_type: 'decision_recorded',
  entity_id: `txn-${i}`,
  actor: { type: 'agent', id: 'investigation-agent' },
  payload_summary: { fields: ['disposition'], disposition: i % 2 ? 'approve' : 'reject' },
  timestamp: new Date(Date.UTC(2026, 6, 26, 9, 0, i)),
});

/** A valid chain under `secret`, as a bake on a box with that AUDIT_SECRET would leave it. */
function chain(secret: string, n = 3): AuditRecord[] {
  const out: AuditRecord[] = [];
  let prev = GENESIS_HASH;
  for (let i = 0; i < n; i++) {
    const rec = buildAuditRecord(secret, prev, ev(i));
    out.push({ ...rec, _id: `id-${i}` } as AuditRecord);
    prev = rec.current_hash;
  }
  return out;
}

/** stageExport's only I/O, stubbed: one array per replay collection. */
function loader(audit: AuditRecord[], others: Record<string, any[]> = {}) {
  return vi.fn(async (dst: string) => {
    if (dst === REPLAY_COLLECTIONS.audit_trail) return audit;
    return others[dst] ?? [{ _id: `${dst}-1`, ts: new Date(Date.UTC(2026, 6, 26)) }];
  });
}

describe('normalizeAudit — the export-time key normalization', () => {
  it('rewrites a box-signed chain to the dev secret', () => {
    const out = normalizeAudit(chain(BOX), BOX) as AuditRecord[];

    expect(verifyChain(DEV_AUDIT_SECRET, out).ok).toBe(true);
    expect(verifyChain(BOX, out).ok).toBe(false);
  });

  it('leaves an already-dev-signed chain byte-identical — a laptop bake must not be rewritten', () => {
    const input = chain(DEV_AUDIT_SECRET);

    const out = normalizeAudit(input, DEV_AUDIT_SECRET);

    // Same objects, not merely equal: the early return is what keeps hmac_key_version from
    // creeping up by one on every local export.
    expect(out).toBe(input);
    expect(out.map((r: AuditRecord) => r.hmac_key_version)).toEqual([1, 1, 1]);
  });

  it('passes an empty chain through instead of throwing', () => {
    expect(normalizeAudit([], BOX)).toEqual([]);
  });

  it('THROWS rather than exporting a chain that verifies under no key', () => {
    const tampered = chain(BOX);
    // Content changed without recomputing the hash: real tampering, not a key rotation. Exporting
    // this would commit it, and every box would then restore it.
    tampered[1].payload_summary = { fields: ['disposition'], disposition: 'approve-TAMPERED' };

    expect(() => normalizeAudit(tampered, BOX)).toThrow(/does not verify under this environment's AUDIT_SECRET/);
  });
});

describe('stageExport — all four files or none', () => {
  it('stages every replay collection with the audit chain normalized', async () => {
    const staged = await stageExport(loader(chain(BOX)), BOX, '/out');

    expect(staged.map(f => f.path)).toEqual([
      '/out/replay_events.json', '/out/replay_analysis.json',
      '/out/replay_reviews.json', '/out/replay_audit.json',
    ]);
    // Read back through EJSON.parse, not as plain JSON: `relaxed:false` wraps every int as
    // {$numberInt:"2"}, so a `=== 2` check on the raw JSON fails against correct output. That
    // wrapping is the same one that broke a hand-written replay fixture, where the client's
    // Number.isFinite(t.ms) guard silently dropped {$numberInt:"22"}.
    const parsed = BSON.EJSON.parse(staged.find(f => f.path.endsWith('replay_audit.json'))!.json) as any[];
    expect(parsed).toHaveLength(3);
    expect(parsed.map(r => r.hmac_key_version)).toEqual([2, 2, 2]);
    expect(verifyChain(DEV_AUDIT_SECRET, parsed as AuditRecord[]).ok).toBe(true);
  });

  it('throws before returning ANY staged file when the chain is tampered', async () => {
    const tampered = chain(BOX);
    tampered[1].payload_summary = { fields: ['disposition'], disposition: 'approve-TAMPERED' };
    const load = loader(tampered);

    await expect(stageExport(load, BOX, '/out')).rejects.toThrow(/refusing to export/);

    // The regression this pins: replay_audit is LAST, so all four collections were read — i.e. a
    // write-as-you-go loop would already have written the first three by the time it threw. Because
    // stageExport returns nothing here, main() reaches no writeFileSync at all.
    expect(load).toHaveBeenCalledTimes(4);
    expect(load).toHaveBeenLastCalledWith(REPLAY_COLLECTIONS.audit_trail);
  });

  it('reports per-collection counts, which is what the summary log is built from', async () => {
    const staged = await stageExport(loader(chain(BOX, 5), { replay_analysis: [] }), BOX, '/out');

    expect(Object.fromEntries(staged.map(f => [f.path.split('/').pop(), f.count]))).toEqual({
      'replay_events.json': 1, 'replay_analysis.json': 0, 'replay_reviews.json': 1, 'replay_audit.json': 5,
    });
  });

  it('serializes as canonical EJSON so Dates survive the round-trip', async () => {
    const staged = await stageExport(loader(chain(DEV_AUDIT_SECRET)), DEV_AUDIT_SECRET, '/out');

    const audit = JSON.parse(staged.find(f => f.path.endsWith('replay_audit.json'))!.json);
    // relaxed:false renders a Date as {$date:{$numberLong}} — restore:replay depends on that,
    // because the chain hashes the timestamp and an ISO string hashes differently to a Date.
    expect(audit[0].timestamp).toHaveProperty('$date');
  });
});
