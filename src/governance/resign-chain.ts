import type { Db } from 'mongodb';
import { GENESIS_HASH, computeHash, verifyChain, type AuditRecord } from './audit-chain';

/**
 * Re-sign an audit chain under a different HMAC secret — a key rotation, not a repair.
 *
 * WHY THIS IS NEEDED AT DEPLOY TIME
 * The committed recording in `data/replay/replay_audit.json` was signed with whatever AUDIT_SECRET
 * was set when it was baked — in practice the dev fallback from src/config.ts, because baking is a
 * local/CI step. A deployed box configured with a real, strong AUDIT_SECRET then recomputes every
 * HMAC over the restored records and correctly reports "AUDIT CHAIN BROKEN … hmac_mismatch". The
 * ledger is intact; only the key differs. `pnpm restore:replay` therefore hands the chain to this
 * function so a fresh deploy never shows a false tamper alarm.
 *
 * The wrong fix is to put the dev secret in the deployed env — that ships a publicly-known audit
 * key. The right fix is to re-sign, which is what a real rotation does.
 */

/** Fields the chain actually signs. Anything else on the record is derived and not hashed. */
function eventOf(r: AuditRecord) {
  return {
    event_type: r.event_type, entity_id: r.entity_id, actor: r.actor,
    payload_summary: r.payload_summary, timestamp: r.timestamp,
  };
}

/**
 * Re-sign an ordered chain IN MEMORY, returning new records. Pure — no database, no mutation of the
 * input. Used by `resignAuditChain` (deploy-time rotation) and by `pnpm export:replay`, which has to
 * normalize the artifact it writes without touching the cluster it read from.
 *
 * Returns null when the chain does not verify under `oldSecret`, i.e. the caller must not re-sign.
 */
export function resignRecords(
  records: AuditRecord[], oldSecret: string, newSecret: string,
): AuditRecord[] | null {
  if (!verifyChain(oldSecret, records).ok) return null;
  let prev = GENESIS_HASH;
  return records.map(r => {
    const current_hash = computeHash(newSecret, prev, eventOf(r));
    const out = {
      ...r,
      previous_hash: prev,
      current_hash,
      hmac_key_version: (r.hmac_key_version ?? 1) + 1,
    };
    prev = current_hash;
    return out;
  });
}

export interface ResignResult {
  /** 'resigned' — keys differed and the chain was rewritten. */
  status: 'resigned' | 'already_valid' | 'empty' | 'tampered';
  records: number;
  /** Set when status is 'tampered': why the chain failed to verify under the old secret. */
  brokenLinks?: { index: number; reason: string }[];
}

/**
 * Bring `collection` into agreement with `newSecret`.
 *
 * Refuses to touch anything if the chain does not verify under `oldSecret` — that would mean real
 * content tampering, and re-signing would launder it into a valid-looking ledger. Returns
 * 'tampered' in that case so the caller can fail loudly.
 *
 * Content (event_type, entity_id, actor, payload_summary, timestamp) is never modified; only
 * previous_hash / current_hash / hmac_key_version are. Idempotent: a chain already valid under
 * `newSecret` is left alone and reported as 'already_valid'.
 */
export async function resignAuditChain(
  db: Db, collection: string, oldSecret: string, newSecret: string,
): Promise<ResignResult> {
  const coll = db.collection<AuditRecord>(collection);
  // _id order is insertion order here, which is chain order — restore:replay inserts `ordered: true`
  // from the exported array, and bake snapshots in the same order.
  const recs = await coll.find({}).sort({ _id: 1 }).toArray();
  if (recs.length === 0) return { status: 'empty', records: 0 };

  // Already correct (re-run, or baked with the same secret the box uses) — do nothing.
  if (verifyChain(newSecret, recs).ok) return { status: 'already_valid', records: recs.length };

  const underOld = verifyChain(oldSecret, recs);
  if (!underOld.ok) {
    return { status: 'tampered', records: recs.length, brokenLinks: underOld.brokenLinks };
  }

  // Recompute forward from genesis so previous_hash links stay consistent with the new hashes.
  let prev = GENESIS_HASH;
  const ops = recs.map(r => {
    const current_hash = computeHash(newSecret, prev, eventOf(r));
    const op = {
      updateOne: {
        filter: { _id: r._id },
        // Bump the key version: the records are now signed with a different key than v1.
        update: { $set: { previous_hash: prev, current_hash, hmac_key_version: (r.hmac_key_version ?? 1) + 1 } },
      },
    };
    prev = current_hash;
    return op;
  });
  await coll.bulkWrite(ops as never, { ordered: true });

  // Read back and verify rather than trusting the write — this is the integrity story of the demo.
  const after = await coll.find({}).sort({ _id: 1 }).toArray();
  const check = verifyChain(newSecret, after);
  if (!check.ok) {
    throw new Error(`audit chain re-sign failed verification: ${JSON.stringify(check.brokenLinks)}`);
  }
  return { status: 'resigned', records: after.length };
}
