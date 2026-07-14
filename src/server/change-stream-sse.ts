import type { Db } from 'mongodb';
import { logger } from '../observability/logger';

export interface ChangeEvent {
  type: 'change';
  collection: string;
  operation: string;
  doc: Record<string, unknown> | null;
}

type Subscriber = (ev: ChangeEvent) => void;

/** Collections whose writes the control-room UI projects. `policies` powers the
 *  "POLICY UPDATED LIVE" stage beat: edit a policy in the DB and every connected console reacts. */
export const WATCHED_COLLECTIONS = ['transactions', 'cases', 'case_decisions', 'reviews', 'audit_trail', 'agent_events', 'case_analysis', 'policies'];

/**
 * A single DB-wide change stream fanned out to all SSE subscribers — the KickOff pattern:
 * agents/workflow write to Mongo, one change stream surfaces every write, the UI is a pure
 * projection. `full_document: 'updateLookup'` so updates carry the post-image.
 */
export class ChangeStreamHub {
  private subs = new Set<Subscriber>();
  private stream: any = null;

  constructor(private db: Db) {}

  start(): void {
    if (this.stream) return;
    try {
      this.stream = this.db.watch([], { fullDocument: 'updateLookup' });
      this.stream.on('change', (change: any) => {
        const collection = change.ns?.coll as string;
        if (!WATCHED_COLLECTIONS.includes(collection)) return;
        // Deletes are maintenance (Reset clears collections) with no document to project — never
        // surface them to the UI. Only inserts/updates/replaces carry meaningful state.
        if (change.operationType === 'delete') return;
        const ev: ChangeEvent = {
          type: 'change', collection, operation: change.operationType,
          doc: sanitize(change.fullDocument ?? change.documentKey ?? null),
        };
        for (const s of this.subs) { try { s(ev); } catch { /* never let one subscriber break the fan-out */ } }
      });
      this.stream.on('error', (err: unknown) => logger.warn('change stream error', { err: String(err) }));
      logger.info('change stream started', { collections: WATCHED_COLLECTIONS });
    } catch (err) {
      logger.warn('change stream unavailable (needs a replica set / Atlas)', { err: String(err) });
    }
  }

  subscribe(fn: Subscriber): () => void {
    this.subs.add(fn);
    return () => { this.subs.delete(fn); };
  }

  async stop(): Promise<void> {
    try { await this.stream?.close?.(); } catch { /* ignore */ }
    this.stream = null;
    this.subs.clear();
  }
}

/** Drop the embedding (huge, useless to the UI) and the BSON _id before it hits the wire. */
export function sanitize(doc: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!doc) return null;
  const { embedding, _id, ...rest } = doc as any;
  return rest;
}
