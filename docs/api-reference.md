# API reference

The control-room API. All routes are mounted by
[`src/server/routes.ts`](../src/server/routes.ts) except `/api/health`, which is mounted by
[`src/server/app.ts`](../src/server/app.ts).

Base URL is the server root: `http://localhost:8000` by default (`PORT`).

All request and response bodies are JSON, serialized by `JSON.stringify`, not as Extended JSON. A stored
BSON date arrives as a plain ISO 8601 string, and an `ObjectId` as its hex string. `Decimal128` is the
exception, because it carries its own `toJSON`: an `amount` read straight from a document arrives as
`{"$numberDecimal": "4950.00"}`. Routes that pass an amount through `moneyToNumber` return a plain
number; the shapes below show which is which.

## Authentication

Marshal issues stateless bearer tokens. A token is `sessionId.exp.mac`, where `mac` is
`HMAC-SHA256(SESSION_SECRET, "sessionId.exp")`. There is no server-side session store.

Send it as `Authorization: Bearer <token>`. A bare header value with no `Bearer ` prefix is also
accepted.

Tokens expire 1,800 seconds (30 minutes) after issue.

The session id is derived only from a verified token. It is never read from a request body.

State-mutating routes require a valid token and return `401` without one:

- `POST /api/reviews/:id/resolve`
- `POST /api/reset`
- `POST /api/investigate/run`

`GET /api/reviews` accepts a token optionally. With one, the response is filtered to exclude reviews
this session has already resolved. Without one, the unfiltered list is returned.

All other routes are unauthenticated.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/health` | no | Liveness |
| `POST` | `/api/token` | no | Mint a session token |
| `GET` | `/api/cases` | no | Recent transactions |
| `GET` | `/api/cases/:id` | no | Full analysis for one case |
| `GET` | `/api/capabilities` | no | Capability exercise counts |
| `GET` | `/api/feed` | no | Recent pipeline events |
| `GET` | `/api/reviews` | optional | Pending human-review gate |
| `POST` | `/api/reviews/:id/resolve` | yes | Resolve a held case |
| `GET` | `/api/mode` | no | Runtime mode and UI flags |
| `GET` | `/api/replay` | no | The full recorded run |
| `POST` | `/api/reset` | yes | Reset to a clean slate |
| `POST` | `/api/investigate/run` | yes | Launch an investigation run |
| `GET` | `/api/stats` | no | Counts, scorecard, latency |
| `GET` | `/api/audit/verify` | no | Verify the audit chain |
| `GET` | `/api/stream` | no | Server-sent change events |

### GET /api/health

Liveness check. Available even when the app is constructed without database dependencies, and it does
not touch MongoDB, Voyage, or the LLM provider. A `200` means the process is serving HTTP, not that its
dependencies are reachable.

```json
{ "status": "ok", "app": "Marshal" }
```

### POST /api/token

Mints a session token. Takes no body.

```json
{ "token": "3f7c….1769472000.9a1b…", "sessionId": "3f7c…" }
```

### GET /api/cases

The 50 most recent transactions by `created_at` descending. `_id` and `embedding` are projected out.

```json
{
  "cases": [
    {
      "transaction_id": "txn-review-struct",
      "text": "Cash deposit of 4,950 …",
      "amount": { "$numberDecimal": "4950.00" },
      "currency": "USD",
      "sender": { "name": "…", "account_number": "ACC-…" },
      "recipient": { "name": "…", "account_number": "ACC-…" },
      "status": "pending",
      "lane": "structuring",
      "model_used": "live",
      "created_at": "2026-07-20T10:00:00.000Z"
    }
  ]
}
```

`amount` is `Decimal128` in a migrated collection, so it serializes as `{"$numberDecimal": "…"}`.
See [data-model.md](data-model.md#money).

### GET /api/cases/:id

Full stored analysis for one case, read from `case_analysis` in live mode and `replay_analysis` in
demo mode.

**200, analyzed case.** The stored `case_analysis` document plus `analyzed: true`. Fields:
`transaction_id`, `amount`, `lane`, `sender`, `recipient`, `narrative`, `precedents`, `memory`,
`ring`, `governance`, `verdict`, `tool_calls`, `decision`, `phase`, `evidence_hash`, `snapshot`,
`capabilities`, `updated_at`.

**200, un-analyzed transaction.** When no analysis exists, the raw transaction is returned as a
reference precedent so the UI has something to render:

```json
{
  "analyzed": false,
  "transaction_id": "txn-syn-00016",
  "amount": { "$numberDecimal": "1256.00" },
  "lane": "clean_approve",
  "sender": { "name": "…", "account_number": "ACC-…" },
  "recipient": { "name": "…", "account_number": "ACC-…" },
  "narrative": "…",
  "status": "approved"
}
```

**404** when neither an analysis nor a transaction exists:

```json
{ "error": "not_found" }
```

### GET /api/capabilities

Counts how many recorded events exercised each MongoDB capability. Aggregates
`agent_events` (live) or `replay_events` (demo), unwinding the `capabilities` array.

```json
{
  "counts": {
    "vector": 18, "fulltext": 12, "hybrid": 12,
    "graph": 6, "memory": 8, "governance": 6, "durable": 6, "audit": 6
  }
}
```

Capability values are `vector`, `fulltext`, `hybrid`, `graph`, `memory`, `governance`, `durable`,
`audit`.

### GET /api/feed

The 120 most recent pipeline events by `ts` descending. The limit is `FEED_LIMIT` in
[`src/server/routes.ts`](../src/server/routes.ts).

```json
{
  "events": [
    {
      "run_id": "m4f8k2-9a1b3c",
      "transaction_id": "txn-review-struct",
      "step": "retrieve",
      "headline": "4 precedents (hybrid search)",
      "detail": "txn-struct-01, txn-struct-02, …",
      "capabilities": ["hybrid", "vector", "fulltext"],
      "capability": "hybrid",
      "ts": "2026-07-20T10:00:01.240Z"
    }
  ]
}
```

`step` is one of `triage`, `retrieve`, `recall`, `tool`, `reason`, `graph`, `govern`, `commit`,
`suspend`, `error`.

A `tool` event additionally carries:

```json
{
  "step": "tool",
  "headline": "hybrid_search → 4 results",
  "tool": {
    "name": "hybrid_search",
    "op": "$rankFusion",
    "ms": 41,
    "ok": true,
    "args": { "query": "cash deposit 4950 …", "k": 4 },
    "result_count": 4
  }
}
```

`tool.op` is `null` for a tool with no operator mapping. `detail` is capped at 240 characters and
string args at 120.

### GET /api/reviews

Cases held for human review, read from `reviews` (live) or `replay_reviews` (demo), filtered to
`status: "pending_review"`.

With a valid bearer token, reviews already resolved by this session (recorded in
`session_resolutions`) are excluded.

```json
{
  "reviews": [
    {
      "transaction_id": "txn-review-high",
      "flag_reason": "high_value_approval",
      "rules_triggered": ["high_value_approval"],
      "evidence_hash": "9f2c…",
      "snapshot": {
        "transaction_id": "txn-review-high",
        "proposed_disposition": "escalate",
        "amount": 82000,
        "risk_factors": ["high_value_approval"],
        "compliance_score": 0.85
      },
      "status": "pending_review",
      "created_at": "2026-07-20T10:00:09.000Z"
    }
  ]
}
```

### POST /api/reviews/:id/resolve

Resolves a held case with a human verdict. Requires a bearer token.

**Request**

```json
{ "decision": "approve" }
```

`decision` must be `approve` or `reject`.

**Demo mode.** The decision is recorded in `session_resolutions`, scoped to the caller's session.
The shared recording is not modified.

```json
{ "status": "committed", "decision": "approve", "scope": "session" }
```

**Live mode.** The review is claimed atomically by transitioning `pending_review` to `resolving`,
the evidence snapshot is re-derived from current state and its hash compared to the stored one, and
the decision is committed. Any failure after the claim releases it back to `pending_review`.

The re-derivation reads `amount` from `transactions`; disposition, risk factors, and compliance score
come from the stored `case_analysis`. The request body carries no hash; the one compared against is the
server's own, stored on the review. See [ADR 0006](adr/0006-evidence-bound-human-review.md).

```json
{ "status": "committed", "decision": "approve", "scope": "shared" }
```

**Errors**

| Status | Body | Cause |
|---|---|---|
| `400` | `{"error": "decision must be approve\|reject"}` | Missing or invalid `decision` |
| `401` | `{"error": "unauthorized — missing/invalid session token"}` | No valid token |
| `404` | `{"status": "not_found", "message": "No pending review for this case."}` | No pending review, or it has no snapshot or hash |
| `409` | `{"status": "already_resolved", "message": "This case was already resolved."}` | Another caller won the claim (live mode) |
| `409` | `{"status": "rejected_stale", "message": "Evidence changed since review."}` | Re-derived evidence hash differs from the stored one |
| `500` | `{"status": "error", "message": "Could not commit the decision; please retry."}` | The commit or a status write failed; the claim was released back to `pending_review`. Releasing is not a rollback: if the decision transaction had already committed, retrying appends a second decision |

### GET /api/mode

The runtime mode and the UI flags derived from `MARSHAL_UI` and `MARSHAL_DENSITY`.

```json
{ "demoMode": true, "uiMode": "classic", "uiDensity": "" }
```

`uiMode` is `classic` or `""`. `uiDensity` is `full`, `lean`, `minimal`, or `""`.

### GET /api/replay

The complete recorded run: every event in `ts` ascending order, plus every case analysis. Read from
`replay_events` and `replay_analysis` in demo mode, and from the working collections in live mode.

```json
{ "events": [ … ], "analyses": [ … ] }
```

Event and analysis shapes match `/api/feed` and `/api/cases/:id`.

### POST /api/reset

Resets to a clean, all-pending slate. Requires a bearer token.

**Demo mode.** Deletes only this session's rows from `session_resolutions`. The shared recording is
untouched.

```json
{ "status": "reset", "scope": "session", "transactions": 15, "demoMode": true }
```

**Live mode.** Clears `cases`, `case_decisions`, `reviews`, `audit_trail`, `agent_events`, and
`case_analysis`, then restores each seed transaction's original status.

```json
{ "status": "reset", "scope": "shared", "transactions": 15, "demoMode": false }
```

### POST /api/investigate/run

Launches an investigation run over every pending transaction. Requires a bearer token.

**Demo mode.** Returns immediately without running anything. The client drives a replay.

```json
{ "status": "replay" }
```

**Live mode.** Starts the pipeline as a fire-and-forget task and returns. Progress is observed via
`/api/stream`.

```json
{ "status": "started" }
```

**Errors**

| Status | Body | Cause |
|---|---|---|
| `401` | `{"error": "unauthorized — missing/invalid session token"}` | No valid token |
| `409` | `{"status": "already_running"}` | A run is in flight in this process |

### GET /api/stats

Counts, decision-quality scorecard, and latency measurements. Cached in-process for 30 seconds;
concurrent requests during a cache miss share one aggregation.

```json
{
  "counts": {
    "transactions": 12015, "precedents": 12009, "pending": 6,
    "policies": 5, "audit_events": 6, "agent_events": 64, "investigated": 6
  },
  "scorecard": { "n": 6, "accuracy": 1, "fraudRecall": 1, "f1Macro": 1 },
  "latency_p50_ms": 8420,
  "stages": {
    "retrieve": { "n": 6, "p50": 34, "p95": null, "p99": null }
  },
  "stage_share": { "reason": 0.45, "tool": 0.304, "govern": 0.161, "retrieve": 0.076, "graph": 0.005 },
  "generated_at": "2026-07-20T10:05:00.000Z"
}
```

`stages[*].p95` and `p99` are `null` below 100 samples. `stages` and `stage_share` are `null` when
no events have been recorded. `scorecard` is `null` when no case has both a lane and a decided
disposition. `latency_p50_ms` is `null` when no case span could be measured.

`stage_share` keys are step names, but the shares are attributed one event late: an interval is named
for the event that opens it, while each event is written after its own stage's work completes. The
values are a coarse indicator that a case is dominated by model time, not a per-stage measurement. See
[known limits](architecture.md#known-limits).

In demo mode, `counts.transactions` and `counts.precedents` come from `replay_meta`, so they describe
the cluster the recording was produced on rather than the cluster replaying it.

**Errors**

| Status | Body | Cause |
|---|---|---|
| `503` | `{"error": "stats_unavailable"}` | The aggregation failed and no cached snapshot exists |

When a cached snapshot exists, a failed refresh serves the stale snapshot with `200` instead of
erroring.

### GET /api/audit/verify

Recomputes every link in the audit chain under the configured `AUDIT_SECRET`. Reads `audit_trail`
in live mode and `replay_audit` in demo mode.

```json
{ "ok": true, "brokenLinks": [] }
```

```json
{
  "ok": false,
  "brokenLinks": [
    { "index": 3, "reason": "key_mismatch" }
  ]
}
```

`reason` is one of:

| Reason | Meaning |
|---|---|
| `chain_link_broken` | The record's `previous_hash` does not match the prior record's `current_hash` |
| `key_mismatch` | The HMAC does not verify and the record names a different `hmac_key_id` than the configured secret derives |
| `hmac_mismatch` | The HMAC does not verify under a key whose fingerprint matches, or the record names no key |

`index` is the zero-based position in the `_id`-ascending record order.

### GET /api/stream

A Server-Sent Events stream of MongoDB change events. `Content-Type: text/event-stream`.

Two event types are emitted:

```
event: change
data: {"type":"change","collection":"agent_events","operation":"insert","doc":{ … }}

event: ping
data: {}
```

`ping` is sent every 15 seconds to keep proxies from dropping the connection.

Watched collections: `transactions`, `cases`, `case_decisions`, `reviews`, `audit_trail`,
`agent_events`, `case_analysis`, `policies`. A change to any other collection is dropped, including the
`replay_*` collections, so a write to the recording produces no event even in demo mode.

`operation` is `insert`, `update`, or `replace`. Deletes are not forwarded: they are maintenance
(a reset clearing collections) and carry no document to project.

`doc` has `embedding` and `_id` removed. The stream uses `fullDocument: 'updateLookup'`, so an
update carries the post-update document.

The server holds one change stream for all subscribers and reconnects from the last resume token
with a backoff of 250, 1000, 2500, 5000, then 10000 ms. On an unresumable error (`ChangeStreamHistoryLost`,
code 286, or `InvalidResumeToken`, code 260) it restarts without a resume token rather than going
silent.

Late joiners should call `GET /api/cases` for current state before relying on the stream.
