import type { Db } from 'mongodb';
import {
  buildAuditRecord, verifyChain, GENESIS_HASH, type AuditEvent, type AuditRecord, type ChainVerification,
} from './audit-chain';

export const AUDIT_COLLECTION = 'audit_trail';

/**
 * Append-only, HMAC hash-chained audit store on MongoDB. Each append reads the latest record's
 * hash, chains the new event to it, and inserts. `verify` recomputes the whole chain. The HMAC
 * secret lives host-side (config), never in the stored records.
 */
export class AuditStore {
  // `collectionName` defaults to the working audit trail; demo-mode verification points it at the
  // immutable replay copy so a cleared live run can't make the audit chip read as broken/empty.
  constructor(private db: Db, private secret: string, private keyVersion = 1, private collectionName: string = AUDIT_COLLECTION) {}

  private col() { return this.db.collection<AuditRecord>(this.collectionName); }

  /**
   * Append a chained event. When a `session` is passed, the read-tail + insert both run inside the
   * caller's transaction, so the audit entry commits ATOMICALLY with the decision it records
   * (review finding #3) — no window where a decision exists without its audit link.
   */
  async append(event: AuditEvent, session?: any): Promise<AuditRecord> {
    const last = await this.col().find({}, session ? { session } : {}).sort({ _id: -1 }).limit(1).next();
    const previousHash = last?.current_hash ?? GENESIS_HASH;
    const record = buildAuditRecord(this.secret, previousHash, event, this.keyVersion);
    await this.col().insertOne(record as any, session ? { session } : {});
    return record;
  }

  async verify(): Promise<ChainVerification> {
    const records = await this.col().find({}).sort({ _id: 1 }).toArray();
    return verifyChain(this.secret, records as AuditRecord[]);
  }
}
