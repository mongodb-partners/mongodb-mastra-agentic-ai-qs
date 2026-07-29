import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Db } from 'mongodb';
import type { Config } from '../config';
import { ChangeStreamHub } from './change-stream-sse';
import { AuditStore } from '../governance/audit-store';
import { resolveReview } from '../workflow/investigate';
import { createWorkflowMastra, resumeReviewGate } from '../workflow/review-workflow';
import type { EvidenceSnapshot } from '../workflow/evidence';
import { moneyToNumber } from '../money';
import { runPendingInvestigations, RUN_STATE_COLLECTIONS } from '../workflow/run-engine';
import { loadTransactionSeed } from '../ingestion/transaction-fixtures';
import { logger } from '../observability/logger';
import { newSessionId, signToken, verifyToken, bearer } from './session';
import { gatherStats, type StatsSnapshot } from './stats';
import { recordingSource, readReplayMeta } from '../data/replay-store';

/**
 * How many recent events `/api/feed` backfills. A run emits one event per pipeline stage PLUS one
 * per agent tool call — ~55-70 for the six-case demo, up from 38 before tool calls were recorded —
 * so 60 no longer covers a full run on a fresh page load. The client cap in public/app.js's
 * addFeed() must stay at or above this number, or the DOM drops what the server sent.
 */
export const FEED_LIMIT = 120;

/**
 * Re-derive the evidence snapshot from CURRENT case/transaction state (review finding #2), so the
 * stale-evidence check compares live state to the hash captured at suspend-time — not a stored
 * snapshot to itself. Returns null if the case has no analysis yet (caller falls back).
 */
async function deriveEvidenceSnapshot(db: Db, transactionId: string): Promise<EvidenceSnapshot | null> {
  const a = await db.collection('case_analysis').findOne({ transaction_id: transactionId });
  const txn = await db.collection('transactions').findOne({ transaction_id: transactionId });
  if (!a || !txn) return null;
  return {
    transaction_id: transactionId,
    proposed_disposition: a.decision?.disposition,
    // `txn.amount` is a Decimal128 in a migrated collection and a number in an un-migrated one.
    // Normalizing makes the re-derived hash a function of the value, so it matches the hash
    // captured at suspend-time either way. Without this, every held case resolves 409 stale.
    amount: moneyToNumber(txn.amount),
    risk_factors: a.decision?.risk_factors ?? [],
    compliance_score: a.governance?.compliance_score ?? 0,
  } as EvidenceSnapshot;
}

/** Mount the control-room API on an app. `hub` is a started ChangeStreamHub over the same Db. */
export function mountRoutes(app: Hono, cfg: Config, db: Db, hub: ChangeStreamHub): void {
  // Derive the caller's session id ONLY from a verified Bearer token (never the body). Signed with
  // the dedicated SESSION secret — kept separate from the audit-chain secret so neither can forge
  // the other. State-mutating routes call this and return 401 when it is null (blocks anonymous /
  // cross-site callers from resetting state, launching runs, or resolving reviews — finding #7).
  const sidOf = (c: any): string | null => verifyToken(cfg.sessionSecret, bearer(c.req.header('authorization')));

  // Where recorded-run content is read from: the working collections in live mode, the immutable
  // `replay_*` copies in demo mode. Isolating these means a live run/reset can never corrupt the
  // demo recording — the two modes coexist on one cluster (see src/data/replay-store.ts).
  const REC = recordingSource(cfg.demoMode);

  // ONE workflow instance for the process, constructed at mount. Safe to build unconditionally: its
  // snapshot store runs on the app's own `db` through a ConnectorHandler, so it opens no connection of
  // its own. It does create `mastra_workflow_snapshot` in the background shortly after mount — which
  // is harmless in demo mode (never resumes a run) and harmless on a read-only user, where the write
  // fails silently without taking the process down. Measured; see createWorkflowMastra.
  const mastra = createWorkflowMastra(db);

  // Mint a stateless session token (per browser tab). No server-side session store.
  app.post('/api/token', c => {
    const sessionId = newSessionId();
    return c.json({ token: signToken(cfg.sessionSecret, sessionId), sessionId });
  });
  // Case queue: recent transactions with their live status.
  app.get('/api/cases', async c => {
    const cases = await db.collection('transactions')
      .find({}, { projection: { _id: 0, embedding: 0 } })
      .sort({ created_at: -1 }).limit(50).toArray();
    return c.json({ cases });
  });

  // Full analysis for one case — powers the case-detail drill-down (projection of stored data).
  // If the case hasn't been investigated this run (e.g. a historical/seed precedent), fall back
  // to the raw transaction so the UI can still show a "reference precedent" card instead of a
  // dead click.
  app.get('/api/cases/:id', async c => {
    const id = c.req.param('id');
    const doc = await db.collection(REC.analysis).findOne({ transaction_id: id }, { projection: { _id: 0 } });
    if (doc) return c.json({ ...doc, analyzed: true });
    const txn = await db.collection('transactions').findOne({ transaction_id: id }, { projection: { _id: 0, embedding: 0 } });
    if (!txn) return c.json({ error: 'not_found' }, 404);
    return c.json({
      analyzed: false, transaction_id: id, amount: txn.amount, lane: txn.lane,
      sender: txn.sender, recipient: txn.recipient, narrative: txn.text, status: txn.status,
    });
  });

  // Capability rollup — how many times each MongoDB capability has been exercised (capability rail).
  app.get('/api/capabilities', async c => {
    const rows = await db.collection(REC.events).aggregate([
      { $match: { capabilities: { $exists: true, $ne: [] } } },
      { $unwind: '$capabilities' },
      { $group: { _id: '$capabilities', count: { $sum: 1 } } },
    ]).toArray();
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r._id as string] = r.count as number;
    return c.json({ counts });
  });

  // Recent agent-operations feed (so a fresh page load shows the last run's activity).
  app.get('/api/feed', async c => {
    const events = await db.collection(REC.events)
      .find({}, { projection: { _id: 0 } }).sort({ ts: -1 }).limit(FEED_LIMIT).toArray();
    return c.json({ events });
  });

  // Pending human-review gate — the shared held cases MINUS the ones THIS session has already
  // resolved (session-scoped so 100+ concurrent users each see/clear their own gate).
  app.get('/api/reviews', async c => {
    const sid = sidOf(c);
    const reviews = await db.collection(REC.reviews)
      .find({ status: 'pending_review' }, { projection: { _id: 0 } }).toArray();
    if (!sid) return c.json({ reviews });
    const resolvedIds = new Set(
      (await db.collection('session_resolutions').find({ sessionId: sid }, { projection: { transaction_id: 1 } }).toArray())
        .map(r => r.transaction_id),
    );
    return c.json({ reviews: reviews.filter(r => !resolvedIds.has(r.transaction_id)) });
  });

  // Resume a suspended case with a human verdict. A valid session token is required (401 otherwise);
  // the client sends ONLY the decision.
  //
  // DEMO mode: the decision is recorded PER SESSION in `session_resolutions`, so 100+ users can each
  // approve/reject the same held case independently without touching the shared replay.
  // LIVE mode: commit to the shared ledger with full verification (evidence-hash + ACID + audit).
  app.post('/api/reviews/:id/resolve', async c => {
    const id = c.req.param('id');
    const sid = sidOf(c);
    if (!sid) return c.json({ error: 'unauthorized — missing/invalid session token' }, 401);
    const body = await c.req.json().catch(() => ({})) as { decision?: 'approve' | 'reject' };
    if (body.decision !== 'approve' && body.decision !== 'reject') {
      return c.json({ error: 'decision must be approve|reject' }, 400);
    }
    // Existence check reads the mode-appropriate source (frozen replay in demo, working in live).
    const review = await db.collection(REC.reviews).findOne({ transaction_id: id, status: 'pending_review' });
    if (!review || !review.snapshot || !review.evidence_hash) {
      return c.json({ status: 'not_found', message: 'No pending review for this case.' }, 404);
    }
    const now = new Date().toISOString();

    // In DEMO mode (100+ concurrent viewers) resolutions are session-scoped — record this user's
    // decision and leave the shared replay pristine. In LIVE mode (quickstart / single user)
    // we commit to the shared ledger with full verification below.
    if (cfg.demoMode) {
      await db.collection('session_resolutions').updateOne(
        { sessionId: sid, transaction_id: id },
        { $set: { sessionId: sid, transaction_id: id, decision: body.decision, decided_at: new Date() } },
        { upsert: true },
      );
      return c.json({ status: 'committed', decision: body.decision, scope: 'session' });
    }

    // LIVE mode: commit to the shared ledger with full verification. (A valid session is already
    // required above — this is the single-writer quickstart path, not an anonymous one.)
    // Concurrency guard (review finding #5): atomically claim the review by transitioning
    // pending_review -> resolving. Only the first concurrent caller wins; a loser sees no pending
    // review and returns 409, so a case can't be double-committed.
    const claim = await db.collection('reviews').findOneAndUpdate(
      { transaction_id: id, status: 'pending_review' },
      { $set: { status: 'resolving' } },
    );
    if (!claim) return c.json({ status: 'already_resolved', message: 'This case was already resolved.' }, 409);

    // Everything after the claim runs in try/catch so ANY failure (a DB blip mid-transaction, a
    // stale-evidence refusal) releases the claim back to pending_review — the review can never get
    // stuck in 'resolving' and become un-retryable (review finding #3).
    try {
      // Real stale-evidence check (review finding #2): re-derive the evidence snapshot from CURRENT
      // case/transaction state and compare its hash to the one stored at suspend-time.
      const currentSnapshot = await deriveEvidenceSnapshot(db, id);
      const current = (currentSnapshot ?? review.snapshot) as EvidenceSnapshot;

      // Resume the durable workflow run when this case has one, so the engine-level suspension is
      // what carries the human verdict back into the ledger. Either way the COMMIT is the same call:
      // the gate step delegates to `resolveReview`, so the evidence-hash re-derivation above and the
      // multi-document ACID transaction are on both paths, and neither trusts the client's payload.
      //
      // The fallback is not hypothetical. A case held before the durable gate shipped has no
      // `workflow_run_id`, a best-effort run-start may have failed, and a run already consumed by a
      // racing caller cannot be resumed twice — `resumeReviewGate` returns undefined for all three,
      // and the atomic claim above has already established that THIS caller owns the resolution.
      const runId = review.workflow_run_id as string | undefined;
      const viaGate = runId
        ? await resumeReviewGate(mastra, db, cfg.auditSecret, {
            runId, transaction_id: id, decision: body.decision, current, now,
          })
        : undefined;
      const res = viaGate
        ? { status: viaGate }
        : await resolveReview(db, cfg.auditSecret, {
            transaction_id: id, human_decision: body.decision,
            echoed_evidence_hash: review.evidence_hash as string,
            current, now,
          });
      if (res.status === 'rejected_stale') {
        await db.collection('reviews').updateOne({ transaction_id: id }, { $set: { status: 'pending_review' } });
        return c.json({ status: 'rejected_stale', message: 'Evidence changed since review.' }, 409);
      }
      await db.collection('reviews').updateOne({ transaction_id: id }, { $set: { status: 'resolved', reviewDecision: body.decision } });
      await db.collection('case_analysis').updateOne({ transaction_id: id }, { $set: { phase: 'committed', 'decision.reviewed_by': 'human', 'decision.disposition': body.decision } });
      return c.json({ status: 'committed', decision: body.decision, scope: 'shared' });
    } catch (err) {
      await db.collection('reviews').updateOne({ transaction_id: id }, { $set: { status: 'pending_review' } }).catch(() => {});
      logger.error('resolve failed; released claim', { transaction_id: id, err: String(err) });
      return c.json({ status: 'error', message: 'Could not commit the decision; please retry.' }, 500);
    }
  });

  // Runtime mode — the UI adapts labels and Launch behavior to this.
  app.get('/api/mode', c =>
    c.json({ demoMode: cfg.demoMode, uiMode: cfg.uiMode, uiDensity: cfg.uiDensity }));

  // Replay data (demo mode): the pre-baked recorded run — ordered agent_events + per-case
  // analyses. The client animates these instead of calling the live agent. Read-only + shared.
  app.get('/api/replay', async c => {
    const events = await db.collection(REC.events).find({}, { projection: { _id: 0 } }).sort({ ts: 1 }).toArray();
    const analyses = await db.collection(REC.analysis).find({}, { projection: { _id: 0 } }).toArray();
    return c.json({ events, analyses });
  });

  // Reset to a clean all-pending slate. In DEMO mode we KEEP the baked replay
  // (case_analysis + agent_events) — that is the recording — and only clear per-run decision
  // state. In live mode we clear everything (a fresh live run regenerates it).
  app.post('/api/reset', async c => {
    const sid = sidOf(c);
    if (!sid) return c.json({ error: 'unauthorized — missing/invalid session token' }, 401);
    // In DEMO mode a reset clears ONLY this user's resolutions — never the shared replay or another
    // user's state (safe for 100+ concurrent attendees).
    if (cfg.demoMode) {
      await db.collection('session_resolutions').deleteMany({ sessionId: sid });
      return c.json({ status: 'reset', scope: 'session', transactions: loadTransactionSeed().length, demoMode: cfg.demoMode });
    }
    // LIVE mode (single-user quickstart): full reset so a fresh live run regenerates everything.
    // The list lives next to the engine that writes it (RUN_STATE_COLLECTIONS) and is shared with
    // `bake-replay.ts`, which resets the same state for the same reason.
    for (const n of RUN_STATE_COLLECTIONS) await db.collection(n).deleteMany({});
    const seed = loadTransactionSeed();
    for (const s of seed) {
      await db.collection('transactions').updateOne({ transaction_id: s.transaction_id }, { $set: { status: s.status } });
    }
    return c.json({ status: 'reset', scope: 'shared', transactions: seed.length, demoMode: cfg.demoMode });
  });

  // LAUNCH. In DEMO mode this is a no-op signal — the client drives a deterministic replay of the
  // baked run (no LLM). In LIVE mode it runs the real agent pipeline (fire-and-forget; the UI
  // watches progress via /api/stream).
  let runInFlight = false; // in-process guard: don't double-process the same pending set (finding #5)
  app.post('/api/investigate/run', async c => {
    if (!sidOf(c)) return c.json({ error: 'unauthorized — missing/invalid session token' }, 401);
    if (cfg.demoMode) return c.json({ status: 'replay' });
    if (runInFlight) return c.json({ status: 'already_running' }, 409);
    runInFlight = true;
    runPendingInvestigations(db, cfg)
      .then(r => logger.info('investigation run complete', r))
      .catch(err => logger.error('investigation run failed', { err: String(err) }))
      .finally(() => { runInFlight = false; });
    return c.json({ status: 'started' });
  });

  // Cluster stats + decision-quality scorecard for the bottom-bar payoff readout. Every number is
  // a real count or measurement from the cluster (nothing staged). Cached in-process for 30s so
  // 100+ concurrent viewers cost one aggregation, not one each.
  let statsCache: { at: number; data: StatsSnapshot } | null = null;
  let statsInFlight: Promise<StatsSnapshot> | null = null;
  // In demo mode the corpus figures come from the recording, not from this cluster — a replay
  // reports the run it is replaying, and the replaying box need not hold that corpus at all (see
  // ReplayMeta). Read once and memoized: `replay_meta` is immutable for the life of the process, so
  // re-reading it on every 30s cache miss would be a query that can only return the same answer.
  // A null result (live mode, or an artifact predating `replay_meta`) leaves both fields undefined
  // and `gatherStats` falls back to the live counts.
  let replayMeta: Awaited<ReturnType<typeof readReplayMeta>> | undefined;
  const corpusFromRecording = async () => {
    if (!cfg.demoMode) return {};
    replayMeta ??= await readReplayMeta(db);
    return replayMeta
      ? { recordedCorpusSize: replayMeta.corpus_size, recordedPrecedents: replayMeta.decided_precedents }
      : {};
  };
  app.get('/api/stats', async c => {
    if (statsCache && Date.now() - statsCache.at < 30_000) return c.json(statsCache.data);
    statsInFlight ??= corpusFromRecording()
      .then(rec => gatherStats(db, { events: REC.events, analysis: REC.analysis, audit: REC.audit, ...rec }))
      .finally(() => { statsInFlight = null; });
    try {
      const data = await statsInFlight;
      statsCache = { at: Date.now(), data };
      return c.json(data);
    } catch (err) {
      logger.error('stats failed', { err: String(err) });
      if (statsCache) return c.json(statsCache.data); // serve stale over erroring
      return c.json({ error: 'stats_unavailable' }, 503);
    }
  });

  // Audit-chain integrity (verify_chain).
  app.get('/api/audit/verify', async c => {
    const v = await new AuditStore(db, cfg.auditSecret, REC.audit).verify();
    return c.json(v);
  });

  // Live change-stream feed. Late-joiners get the current state via /api/cases first.
  app.get('/api/stream', c => streamSSE(c, async stream => {
    const unsub = hub.subscribe(ev => { stream.writeSSE({ event: 'change', data: JSON.stringify(ev) }); });
    // Keep-alive pings so proxies don't drop the connection.
    let open = true;
    stream.onAbort(() => { open = false; unsub(); });
    while (open) { await stream.writeSSE({ event: 'ping', data: '{}' }); await stream.sleep(15000); }
  }));
}
