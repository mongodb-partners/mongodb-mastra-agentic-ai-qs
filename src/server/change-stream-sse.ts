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
 * Reconnect backoff. A replica-set election completes in ~10-12s, so the early retries are what
 * actually recover a demo; the ceiling exists so a genuinely unreachable cluster settles into a slow
 * poll instead of hammering. Exported for the test.
 */
export const RECONNECT_BACKOFF_MS = [250, 1000, 2500, 5000, 10_000] as const;

/** Injectable clock, so the reconnect test does not sleep for real. */
export interface HubDeps {
  setTimeout?: (fn: () => void, ms: number) => any;
  clearTimeout?: (h: any) => void;
}

/**
 * A single DB-wide change stream fanned out to all SSE subscribers — the KickOff pattern:
 * agents/workflow write to Mongo, one change stream surfaces every write, the UI is a pure
 * projection. `full_document: 'updateLookup'` so updates carry the post-image.
 *
 * WHY THIS RECONNECTS. The driver retries a stream it still owns, but a stream that has ERRORED OUT
 * is finished — and this hub is the only writer the UI ever hears from. So the failure mode was
 * silent and total: an Atlas election or a network blip ended the stream, the handler logged a
 * warning, and every connected console froze on its last painted state while still showing a live
 * SSE connection and its keep-alive pings. Nothing recovered it short of restarting the process, and
 * nothing on screen said so. Reconnecting from the last resume token is what makes that survivable.
 */
export class ChangeStreamHub {
  private subs = new Set<Subscriber>();
  private stream: any = null;
  /** Last seen `_id` from a change event — where a reconnect resumes so no write is missed. */
  private resumeToken: unknown = null;
  private retry = 0;
  private timer: any = null;
  private stopped = false;
  private readonly setTimer: (fn: () => void, ms: number) => any;
  private readonly clearTimer: (h: any) => void;

  constructor(private db: Db, deps: HubDeps = {}) {
    this.setTimer = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimeout ?? (h => clearTimeout(h));
  }

  start(): void {
    if (this.stream) return;
    this.stopped = false;
    this.open();
  }

  private open(): void {
    if (this.stopped) return;
    try {
      // `resumeAfter` replays everything since the token, so no write is lost across a blip. On the
      // first connect there is no token and we watch from now.
      this.stream = this.db.watch([], {
        fullDocument: 'updateLookup',
        ...(this.resumeToken ? { resumeAfter: this.resumeToken } : {}),
      });
      this.stream.on('change', (change: any) => {
        // Record the token for EVERY change, including ones we filter out below: it marks our
        // position in the oplog, not our interest in the document. Advancing it only on watched
        // collections would make a reconnect replay every ignored write since the last watched one.
        if (change?._id !== undefined) this.resumeToken = change._id;
        // A change proves the stream is healthy. Reset the backoff here rather than on open, because
        // a stream can open and then immediately fail; only data proves it actually works.
        this.retry = 0;
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
      this.stream.on('error', (err: unknown) => {
        logger.warn('change stream error; reconnecting', { err: String(err) });
        // A resume token the cluster can no longer honour (oplog rolled past it, or the token is
        // from a different cluster) fails the SAME way on every retry. Drop it and reconnect from
        // now: a gap in the feed is recoverable — the UI refetches state via /api/cases — whereas
        // retrying a poisoned token loops until restart.
        if (isUnresumable(err)) {
          logger.warn('resume token no longer valid; resuming from now (feed gap possible)');
          this.resumeToken = null;
        }
        this.scheduleReopen();
      });
      // 'close' without a prior 'error' happens too (a dropped connection the driver gave up on).
      this.stream.on('close', () => { if (!this.stopped) this.scheduleReopen(); });
      logger.info('change stream started', {
        collections: WATCHED_COLLECTIONS, resumed: Boolean(this.resumeToken),
      });
    } catch (err) {
      // `watch()` itself threw — no replica set, or the client is closed. Retry on the same backoff:
      // on Atlas this is transient, and a standalone dev Mongo settles into the 10s ceiling.
      logger.warn('change stream unavailable (needs a replica set / Atlas)', { err: String(err) });
      this.stream = null;
      this.scheduleReopen();
    }
  }

  /** Tear down the dead stream and queue a reopen. Idempotent: 'error' then 'close' schedules once. */
  private scheduleReopen(): void {
    if (this.stopped || this.timer) return;
    const dead = this.stream;
    this.stream = null;
    // Close the corpse so its socket and cursor are released; it has already failed, so ignore.
    try { dead?.removeAllListeners?.(); dead?.close?.()?.catch?.(() => {}); } catch { /* ignore */ }
    const wait = RECONNECT_BACKOFF_MS[Math.min(this.retry, RECONNECT_BACKOFF_MS.length - 1)];
    this.retry++;
    this.timer = this.setTimer(() => { this.timer = null; this.open(); }, wait);
  }

  subscribe(fn: Subscriber): () => void {
    this.subs.add(fn);
    return () => { this.subs.delete(fn); };
  }

  async stop(): Promise<void> {
    // Set first: a close/error firing during teardown must not schedule a reconnect that outlives
    // the process (a leaked timer keeps vitest and a shutting-down server alive).
    this.stopped = true;
    if (this.timer) { this.clearTimer(this.timer); this.timer = null; }
    try { await this.stream?.close?.(); } catch { /* ignore */ }
    this.stream = null;
    this.subs.clear();
  }
}

/**
 * True when the resume token cannot be used again, so retrying with it is futile.
 * 286 = ChangeStreamHistoryLost (oplog rolled past the token), 260 = InvalidResumeToken.
 */
export function isUnresumable(err: unknown): boolean {
  const code = (err as { code?: number })?.code;
  if (code === 286 || code === 260) return true;
  return /ChangeStreamHistoryLost|InvalidResumeToken|resume token/i.test(String(err ?? ''));
}

/** Drop the embedding (huge, useless to the UI) and the BSON _id before it hits the wire. */
export function sanitize(doc: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!doc) return null;
  const { embedding, _id, ...rest } = doc as any;
  return rest;
}
