import { describe, it, expect } from 'vitest';
import {
  sanitize, WATCHED_COLLECTIONS, ChangeStreamHub, isUnresumable, RECONNECT_BACKOFF_MS,
} from './change-stream-sse';

/**
 * A fake change stream that records its own options and lets a test fire 'change'/'error'/'close'.
 * `db.watch()` hands back a new one per call, so the test can assert what a RECONNECT asked for.
 */
function fakeDb() {
  const opened: any[] = [];
  const db = {
    watch(_pipeline: any, options: any) {
      const handlers: Record<string, Function[]> = {};
      const s = {
        options, closed: false,
        on(ev: string, fn: Function) { (handlers[ev] ??= []).push(fn); return s; },
        emit(ev: string, arg?: any) { for (const fn of handlers[ev] ?? []) fn(arg); },
        removeAllListeners() { for (const k of Object.keys(handlers)) delete handlers[k]; },
        close: async () => { s.closed = true; },
      };
      opened.push(s);
      return s;
    },
  };
  return { db: db as any, opened };
}

/** Deterministic clock: collects scheduled callbacks so the test runs them on demand. */
function fakeClock() {
  const queue: { fn: () => void; ms: number }[] = [];
  return {
    deps: {
      setTimeout: (fn: () => void, ms: number) => { queue.push({ fn, ms }); return queue.length; },
      clearTimeout: (h: any) => { if (queue[h - 1]) queue[h - 1] = { fn: () => {}, ms: -1 }; },
    },
    queue,
    /** Fire every pending callback (each may schedule the next). */
    tick() { const pending = queue.splice(0); for (const t of pending) t.fn(); },
    delays: () => queue.map(t => t.ms),
  };
}

describe('change-stream SSE helpers', () => {
  it('sanitize drops embedding and _id but keeps the rest', () => {
    const out = sanitize({ _id: 'x', embedding: [1, 2, 3], transaction_id: 't', status: 'pending' });
    expect(out).toEqual({ transaction_id: 't', status: 'pending' });
  });
  it('sanitize passes null through', () => {
    expect(sanitize(null)).toBeNull();
  });
  it('watches the control-room collections including the agent-events feed, analysis and policies', () => {
    expect(WATCHED_COLLECTIONS).toEqual(['transactions', 'cases', 'case_decisions', 'reviews', 'audit_trail', 'agent_events', 'case_analysis', 'policies']);
  });
});

describe('ChangeStreamHub reconnection', () => {
  const change = (coll: string, id: any = { _data: 'tok1' }) => ({
    _id: id, ns: { coll }, operationType: 'insert', fullDocument: { transaction_id: 't1' },
  });

  it('reopens after an error and resumes from the last token', async () => {
    // The regression: before this, an error only logged. Every connected UI froze until restart.
    const { db, opened } = fakeDb();
    const clock = fakeClock();
    const hub = new ChangeStreamHub(db, clock.deps);
    hub.start();
    expect(opened).toHaveLength(1);
    expect(opened[0].options.resumeAfter).toBeUndefined(); // first connect: watch from now

    opened[0].emit('change', change('transactions', { _data: 'tok-A' }));
    opened[0].emit('error', new Error('primary stepped down'));
    expect(opened).toHaveLength(1); // not yet — the reopen is scheduled, not immediate
    clock.tick();

    expect(opened).toHaveLength(2);
    expect(opened[1].options.resumeAfter).toEqual({ _data: 'tok-A' });
    expect(opened[1].options.fullDocument).toBe('updateLookup');
    await hub.stop();
  });

  it('keeps delivering to subscribers across a reconnect', async () => {
    const { db, opened } = fakeDb();
    const clock = fakeClock();
    const hub = new ChangeStreamHub(db, clock.deps);
    const seen: string[] = [];
    hub.subscribe(ev => seen.push(ev.collection));
    hub.start();

    opened[0].emit('change', change('transactions'));
    opened[0].emit('error', new Error('blip'));
    clock.tick();
    opened[1].emit('change', change('cases'));

    expect(seen).toEqual(['transactions', 'cases']);
    await hub.stop();
  });

  it('backs off on repeated failures and resets after a successful change', async () => {
    const { db, opened } = fakeDb();
    const clock = fakeClock();
    const hub = new ChangeStreamHub(db, clock.deps);
    hub.start();

    opened[0].emit('error', new Error('1'));
    expect(clock.delays()).toEqual([RECONNECT_BACKOFF_MS[0]]);
    clock.tick();
    opened[1].emit('error', new Error('2'));
    expect(clock.delays()).toEqual([RECONNECT_BACKOFF_MS[1]]);
    clock.tick();
    opened[2].emit('error', new Error('3'));
    expect(clock.delays()).toEqual([RECONNECT_BACKOFF_MS[2]]);
    clock.tick();

    // A delivered change proves the stream works — the next failure starts from the bottom again.
    opened[3].emit('change', change('transactions'));
    opened[3].emit('error', new Error('4'));
    expect(clock.delays()).toEqual([RECONNECT_BACKOFF_MS[0]]);
    await hub.stop();
  });

  it('drops an unresumable token instead of retrying it forever', async () => {
    const { db, opened } = fakeDb();
    const clock = fakeClock();
    const hub = new ChangeStreamHub(db, clock.deps);
    hub.start();
    opened[0].emit('change', change('transactions', { _data: 'stale' }));

    const err: any = new Error('cursor killed'); err.code = 286; // ChangeStreamHistoryLost
    opened[0].emit('error', err);
    clock.tick();

    // Resumes from now, accepting a feed gap, rather than replaying a token the cluster rejects.
    expect(opened[1].options.resumeAfter).toBeUndefined();
    await hub.stop();
  });

  it('schedules only one reopen when error is followed by close', async () => {
    const { db, opened } = fakeDb();
    const clock = fakeClock();
    const hub = new ChangeStreamHub(db, clock.deps);
    hub.start();
    opened[0].emit('error', new Error('x'));
    opened[0].emit('close');
    expect(clock.queue).toHaveLength(1);
    clock.tick();
    expect(opened).toHaveLength(2);
    await hub.stop();
  });

  it('stop() cancels a pending reconnect so no timer outlives the process', async () => {
    const { db, opened } = fakeDb();
    const clock = fakeClock();
    const hub = new ChangeStreamHub(db, clock.deps);
    hub.start();
    opened[0].emit('error', new Error('x'));
    await hub.stop();
    clock.tick();
    expect(opened).toHaveLength(1); // never reopened after stop
  });

  it('retries when watch() itself throws (no replica set yet)', async () => {
    let calls = 0;
    const db: any = { watch() { calls++; if (calls === 1) throw new Error('not a replica set'); return fakeDb().db.watch([], {}); } };
    const clock = fakeClock();
    const hub = new ChangeStreamHub(db, clock.deps);
    hub.start();
    expect(calls).toBe(1);
    clock.tick();
    expect(calls).toBe(2);
    await hub.stop();
  });
});

describe('isUnresumable', () => {
  it('recognizes the two codes and the message forms', () => {
    expect(isUnresumable(Object.assign(new Error('x'), { code: 286 }))).toBe(true);
    expect(isUnresumable(Object.assign(new Error('x'), { code: 260 }))).toBe(true);
    expect(isUnresumable(new Error('ChangeStreamHistoryLost'))).toBe(true);
    expect(isUnresumable(new Error('invalid resume token supplied'))).toBe(true);
  });
  it('treats an ordinary network error as resumable', () => {
    expect(isUnresumable(new Error('connection 4 to cluster closed'))).toBe(false);
    expect(isUnresumable(Object.assign(new Error('stepdown'), { code: 189 }))).toBe(false);
  });
});
