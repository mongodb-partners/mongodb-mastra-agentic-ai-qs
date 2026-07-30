# Data model

Every collection lives in one MongoDB database, named by `MONGODB_DB` (default `marshal`). There is
no second datastore.

Schemas that are validated in code are defined with Zod: transactions in
[`src/mastra/schemas/transactions.ts`](../src/mastra/schemas/transactions.ts) and policies in
[`src/governance/policies.ts`](../src/governance/policies.ts). The remaining collections are written
by known code paths and are documented here from those writers.

- [Collections](#collections)
- [transactions](#transactions)
- [policies](#policies)
- [cases](#cases)
- [case_decisions](#case_decisions)
- [case_analysis](#case_analysis)
- [reviews](#reviews)
- [audit_trail](#audit_trail)
- [agent_events](#agent_events)
- [mastra_workflow_snapshot](#mastra_workflow_snapshot)
- [session_resolutions](#session_resolutions)
- [replay_* collections](#replay_-collections)
- [Atlas Search indexes](#atlas-search-indexes)
- [Standard indexes](#standard-indexes)
- [Money](#money)
- [Embeddings](#embeddings)

## Collections

| Collection | Written by | Cleared by a live reset | Read in demo mode |
|---|---|---|---|
| `transactions` | provisioning, seeding, commit | no (statuses restored) | yes |
| `policies` | provisioning | no | yes |
| `cases` | case store | yes | no |
| `case_decisions` | case store | yes | no |
| `case_analysis` | run engine | yes | via `replay_analysis` |
| `reviews` | case store, resolve route | yes | via `replay_reviews` |
| `audit_trail` | audit store | yes | via `replay_audit` |
| `agent_events` | run engine, tool recorder | yes | via `replay_events` |
| `mastra_workflow_snapshot` | `@mastra/mongodb` (engine-managed) | yes | no (demo never suspends) |
| `session_resolutions` | resolve route (demo mode) | no (24h TTL) | yes |
| `replay_events` | `pnpm bake`, `pnpm restore:replay` | never | yes |
| `replay_analysis` | `pnpm bake`, `pnpm restore:replay` | never | yes |
| `replay_reviews` | `pnpm bake`, `pnpm restore:replay` | never | yes |
| `replay_audit` | `pnpm bake`, `pnpm restore:replay` | never | yes |
| `replay_meta` | `pnpm bake`, `pnpm restore:replay` | never | yes |

## transactions

The operational collection. Vector, lexical, hybrid, and graph retrieval all run directly against it.
There is no separate embedding collection or vector store.

| Field | Type | Notes |
|---|---|---|
| `transaction_id` | string | Unique. The join key used everywhere else |
| `text` | string | The case narrative. Embedded and lexically indexed |
| `amount` | `Decimal128` or number | See [Money](#money) |
| `currency` | string | Exactly 3 characters |
| `sender.name` | string | Lexically indexed |
| `sender.account_number` | string | Graph traversal `startWith` and `connectFromField` |
| `recipient.name` | string | Lexically indexed |
| `recipient.account_number` | string | Graph traversal `connectToField` |
| `status` | enum | `pending`, `approved`, `rejected`, `escalated` |
| `lane` | enum | `clean_approve`, `clear_reject`, `structuring`, `high_value`, `ring`, `sanctions` |
| `model_used` | enum | `historical` for seeded precedents, `live` for run-created cases |
| `embedding` | `BinData` or number[] | 1024 dims. See [Embeddings](#embeddings) |
| `created_at` | date | Queue sort key |

The three decided statuses (`approved`, `rejected`, `escalated`) are exported as `DECIDED_STATUSES`
and are the filter for precedent retrieval, so a case can only cite an already-decided case.

`lane` is a ground-truth scenario label. It doubles as the eval label, mapped to an expected
disposition by `EXPECTED_DISPOSITION` in
[`src/ingestion/transaction-fixtures.ts`](../src/ingestion/transaction-fixtures.ts):

| Lane | Expected disposition |
|---|---|
| `clean_approve` | `approve` |
| `clear_reject` | `reject` |
| `structuring` | `escalate` |
| `high_value` | `escalate` |
| `ring` | `escalate` |
| `sanctions` | `reject` |

Two populations share the collection. Fifteen curated fixtures from
`src/ingestion/data/transactions.seed.json`, of which six are `pending` and `live` (one per lane) so
a run always has exactly one case per scenario. And a synthetic decided-precedent corpus with ids
prefixed `txn-syn-`, sized by `SEED_SCALE_COUNT` and generated deterministically from a fixed seed.

Synthetic ids are positional. `txn-syn-00016` names a different transaction across generator
revisions: in the 12k corpus it is `structuring` and escalated, in the 1M corpus it is
`clean_approve` and approved. Do not treat a synthetic id as a stable reference across corpora.

## policies

Five seeded compliance policies. Retrieved by `$vectorSearch` during governance.

| Field | Type | Notes |
|---|---|---|
| `policy_code` | string | Matches `^[A-Z]{2,6}-[A-Z0-9]+-\d{3}$` |
| `policy_text` | string | Written for retrieval, not for display |
| `category` | enum | `aml`, `sanctions`, `fraud`, `kyc`, `privacy` |
| `source` | string | Regulation citation |
| `severity` | enum | `low`, `medium`, `high`, `critical` |
| `rule_version` | int | Positive |
| `is_current_version` | boolean | Exactly one true per `policy_code` |
| `embedding` | number[] | 1024 dims |

Seeded set:

| Code | Category | Severity | Source |
|---|---|---|---|
| `AML-STRUCT-001` | aml | high | 31 U.S.C. § 5324; 31 CFR 1010.314 |
| `SANC-SCREEN-001` | sanctions | critical | OFAC 31 CFR Part 501 |
| `AML-RING-001` | aml | high | FinCEN layering guidance |
| `FRAUD-HIGHVAL-001` | fraud | medium | Internal high-value control |
| `FRAUD-ATO-001` | fraud | high | Internal ATO control |

Severity drives the compliance score deterministically. A score starts at 1.0 and each kept violation
subtracts its penalty: `low` 0.05, `medium` 0.15, `high` 0.25, `critical` 0.4. Below
`COMPLIANCE_THRESHOLD` (0.7) the case is held. The severity used is always the one stored here, never
the one the LLM reported.

Versioning is immutable-append: a superseded policy keeps its document with `is_current_version:
false`, and a partial-unique index (`policy_code_current_unique`) enforces exactly one current
version per code.

## cases

Workflow state per transaction. One document per case, upserted.

| Field | Type | Notes |
|---|---|---|
| `transaction_id` | string | |
| `state` | string | `CLEARED` or `PENDING_REVIEW` |
| `disposition` | string | Set when cleared |
| `decided_at` | date | Set when cleared |
| `evidence_hash` | string | Set when suspended for review |

## case_decisions

Immutable decision records. Inserted inside the commit transaction.

| Field | Type | Notes |
|---|---|---|
| `_id` | string | `dec-<transaction_id>-<ISO timestamp>` |
| `transaction_id` | string | |
| `decision` | enum | `approve`, `reject`, `escalate` |
| `confidence_score` | number | 0 to 100 |
| `risk_factors` | string[] | |
| `reasoning.primary_reasoning` | string | |
| `compliance_score` | number | 0 to 1 |
| `reviewed_by` | enum | `agent` or `human` |
| `created_at` | date | |

## case_analysis

The full stored analysis for one case. The console's case-detail view is a pure projection of this
document; nothing is recomputed at render time.

| Field | Type | Notes |
|---|---|---|
| `transaction_id` | string | |
| `amount`, `lane`, `sender`, `recipient` | | Copied from the transaction |
| `narrative` | string | The transaction's `text` |
| `precedents` | object[] | The retrieved hybrid results, stored inline |
| `memory` | object[] | `{transaction_id, disposition, lane}` for the top 2 precedents |
| `ring` | object | The `$graphLookup` result summary |
| `governance` | object | `{compliance_score, violations, held, dropped_citations, retrieved}` |
| `verdict` | object | `{recommendation, confidence, risk_factors, rationale}` |
| `tool_calls` | object[] | The `tool` sub-document of each recorded tool event |
| `decision` | object | `{disposition, decided_by, risk_factors, rationale}` |
| `phase` | string | `committed` or `suspended` |
| `evidence_hash` | string | |
| `snapshot` | object | The hashed evidence snapshot |
| `capabilities` | string[] | Every capability this case exercised |
| `updated_at` | date | |

`decision.decided_by` is `rules`, `compliance`, `agent`, or `reconciler`, which is how the console
shows who actually decided:

| Value | Meaning |
|---|---|
| `compliance` | A hard pre-LLM rule fired (sanctions hit). The agent was not consulted |
| `agent` | The agent's recommendation was clear-cut and was honored |
| `reconciler` | A deterministic rule tightened the agent's recommendation to `escalate` |
| `rules` | Reserved for a rules-only decision path |

Precedents are stored inline rather than by reference. That is what lets a recording restore onto a
cluster that does not hold the corpus it cited.

## reviews

The human-review gate. One document per held case, upserted.

| Field | Type | Notes |
|---|---|---|
| `transaction_id` | string | |
| `flag_reason` | string | |
| `rules_triggered` | string[] | |
| `evidence_hash` | string | SHA-256 over the canonical snapshot |
| `snapshot` | object | Server-stored evidence, never a client reconstruction |
| `status` | string | `pending_review`, `resolving`, `resolved` |
| `reviewDecision` | string | Set on resolve |
| `created_at` | date | |

`resolving` is a claim state. The resolve route transitions `pending_review` to `resolving` with an
atomic `findOneAndUpdate`; only the first concurrent caller wins. Any failure after the claim
releases it back to `pending_review`, so a review cannot get stuck in `resolving`.

The release is not a rollback. The decision commits in its own transaction before the status moves to
`resolved`, so a failure in that window reopens a review whose decision is already in `case_decisions`
and in the audit chain. The reviewer sees the case again; a second approval appends a second decision.
Reopening is the deliberate choice over leaving the review unclaimable, and closing the gap means
folding the two status writes into the decision transaction.

The snapshot is:

| Field | Type |
|---|---|
| `transaction_id` | string |
| `proposed_disposition` | string |
| `amount` | number (normalized from `Decimal128`) |
| `risk_factors` | string[] |
| `compliance_score` | number |

`amount` is a plain number here on purpose. The canonicalizer walks own properties, and a
`Decimal128`'s only own property is `bytes`, which is not value-canonical: `Decimal128.fromString('1256')`
and `Decimal128.fromString('1256.00')` are the same money and different bytes.

## audit_trail

Append-only, HMAC hash-chained.

| Field | Type | Notes |
|---|---|---|
| `event_type` | string | e.g. `decision_recorded` |
| `entity_id` | string | The transaction or case id |
| `actor` | object | `{type: 'agent'\|'human'\|'system', id: string}` |
| `payload_summary` | object | Shape only: field names, counts. Never raw PII |
| `timestamp` | date | |
| `previous_hash` | 64 hex chars | `GENESIS_HASH` (64 zeros) for the first record |
| `current_hash` | 64 hex chars | `HMAC(secret, previous_hash + canonicalJSON(event))` |
| `hmac_key_id` | 12 hex chars | Fingerprint of the signing key |

`hmac_key_id` is `HMAC(secret, 'marshal-audit-key-id/v1')` truncated to 12 hex characters. It is a
fingerprint of the key, not a version counter. Same key gives the same id on every host forever;
different key gives a different id. That is what lets `/api/audit/verify` report `key_mismatch`
distinctly from `hmac_mismatch`, which call for opposite responses: re-sign versus investigate
tampering.

The secret never appears in a stored record. The fingerprint is a one-way function of it, so
publishing it leaks nothing usable.

Appends run inside the caller's transaction when a session is passed, so the tail read and the insert
are both session-scoped, and a decision never commits without its audit record.

The hash covers the event fields above only. It does not cover the `case_decisions` document, so an
edit to a stored decision's `confidence_score` or `reasoning` leaves the chain verifying clean.
Verification detects an edited, reordered, inserted, or missing audit record.

Two concurrent commits reading the same tail would both chain off it, because independent inserts do
not raise a write conflict. Nothing in the code prevents that fork; commits happen to be serialized.
See [ADR 0005](adr/0005-hmac-audit-chain.md).

## agent_events

The pipeline timeline. Every stage of every case writes one document, and every agent tool call
writes one more. This is the collection the live feed, the replay, and the capability rail all read.

| Field | Type | Notes |
|---|---|---|
| `run_id` | string | Tags one `runPendingInvestigations` call |
| `transaction_id` | string | |
| `step` | string | `triage`, `retrieve`, `recall`, `tool`, `reason`, `graph`, `govern`, `commit`, `suspend`, `error` |
| `headline` | string | One line for the feed |
| `detail` | string | Capped at 240 characters |
| `capabilities` | string[] | Every capability this step exercised |
| `capability` | string | `capabilities[0]`, for single-value queries |
| `tool` | object | Only on `step: 'tool'` |
| `ts` | date | |

The `tool` sub-document:

| Field | Type | Notes |
|---|---|---|
| `name` | string | The Mastra tool id |
| `op` | string or null | The MongoDB operator that served it |
| `ms` | number | Measured in the tool hooks, not at write time |
| `ok` | boolean | |
| `args` | object | Scalars only; strings capped at 120 characters |
| `result_count` | number or null | |

Tool-to-operator mapping, from
[`src/mastra/tool-recorder.ts`](../src/mastra/tool-recorder.ts):

| Tool | Operator | Capabilities |
|---|---|---|
| `hybrid_search` | `$rankFusion` | hybrid, vector, fulltext |
| `search_precedent` | `$vectorSearch` | vector |
| `search_text` | `$search` | fulltext |
| `trace_funds` | `$graphLookup` | graph |
| `recall_verdicts` | `$vectorSearch` | memory |

`run_id` exists because `agent_events` is only cleared by a reset. Without it, the same case
investigated in two runs is indistinguishable from one very slow case, and the span calculation
reported 290 seconds for cases that took 7.

A tool event's `ts` is the call's real completion instant, captured in the hook. The batch is written
after the verdict returns, so a write-time timestamp would put every tool call in one millisecond,
and the replay paces off `ts` deltas.

Only tool calls from the committed verdict attempt are written. A retried attempt's calls really ran,
but they belong to a discarded reasoning pass and are dropped.

## mastra_workflow_snapshot

Suspended and completed workflow runs, written by `@mastra/mongodb`'s `WorkflowsStorageMongoDB`. The
schema belongs to the library, not to this app, so it is not documented field-by-field here.

Two things about it are this app's decisions rather than the library's. It is the **only** collection
the store owns: a bare `MongoDBStore` provisions 31 collections for agents, threads and datasets that
this app never uses, so the `Mastra` instance is built with a `MastraCompositeStore` scoped to the
workflows domain alone ([`src/workflow/review-workflow.ts`](../src/workflow/review-workflow.ts)) —
the "one cluster, these collections" story in
[ADR 0001](adr/0001-one-cluster-for-every-capability.md) would otherwise stop being true. And the
collection is **advisory**: the authoritative decision record is the ACID commit in `case_decisions`
plus the hash chain in `audit_trail`, because a workflow snapshot cannot join that transaction.

Created by the engine on app boot, not by provisioning, and indexed by the library. `pnpm provision`
only asserts the name against the library's own declaration, so a rename upstream fails loudly
instead of silently leaving a second collection behind. A live reset clears it along with the rest of
the run state. Demo mode never suspends a run, so a read-only deployment that cannot create it never
reads it either.

## session_resolutions

Per-session review decisions in demo mode, so many concurrent viewers each clear their own gate
without touching the shared recording.

| Field | Type | Notes |
|---|---|---|
| `sessionId` | string | From the verified bearer token |
| `transaction_id` | string | |
| `decision` | enum | `approve` or `reject` |
| `decided_at` | date | TTL anchor, 24 hours |

## replay_* collections

Immutable copies of a recorded run. Demo mode reads only these; live runs and resets never touch
them.

| Working collection | Replay copy |
|---|---|
| `agent_events` | `replay_events` |
| `case_analysis` | `replay_analysis` |
| `reviews` | `replay_reviews` |
| `audit_trail` | `replay_audit` |

`replay_meta` holds a single provenance document:

| Field | Type | Notes |
|---|---|---|
| `corpus_size` | number | `transactions` count on the cluster the recording ran against |
| `decided_precedents` | number | Decided count on that same cluster, **as of the moment the run started**. The cases the recording covers are excluded, because the snapshot runs after they were decided |
| `source_db` | string | Database the run was recorded on |
| `recorded_at` | date | |
| `app_commit` | string | Short hash, or `unknown` |
| `atlas_tier` | string | e.g. `M30`, or `unknown` |
| `llm_model` | string | From `LLM_MODEL` at bake time, or `unknown` |

Provenance travels with the artifact because demo mode publishes the recording's timings as
`latency_p50_ms`, and a latency claim without a tier, a model, and a corpus size cannot be checked.
Tier matters measurably: adding a second 1M vector index to one M30 moved an untouched index's p50
from 21.0 to 179.6 ms.

The committed artifact in `data/replay/` carries `corpus_size` 1000015, `decided_precedents` 1000009,
`atlas_tier` M30.

The two counts must reconcile against the recording: `corpus_size - decided_precedents` equals the
number of cases the recording covers (6), because `status` partitions exactly into `pending` and
`DECIDED_STATUSES` and the replay depicts those six cases while they were still undecided. Demo mode
publishes both numbers side by side in the status bar, so a viewer can do the subtraction. An
artifact that does not reconcile is showing a corpus that cannot account for its own queue.
`replay-fixtures.test.ts` asserts this on the committed artifact.

All three provenance strings are always present on read. `readReplayMeta` fills `unknown` for
artifacts baked before the fields existed, so a reader never has to guard a field that renders as a
blank where a value would go.

## Atlas Search indexes

Four Atlas Search indexes, all created by `pnpm provision`.

### transactions_vector_index (`vectorSearch`)

```json
{
  "fields": [
    { "type": "vector", "path": "embedding", "numDimensions": 1024,
      "similarity": "cosine", "quantization": "none" },
    { "type": "filter", "path": "status" }
  ]
}
```

`quantization` is `binary` when the corpus has 100,000 or more documents, `none` below. The `status`
filter path is what lets precedent retrieval restrict to decided cases inside `$vectorSearch` rather
than after it.

A `vectorSearch` definition is updated in place when it drifts from the code. Atlas stages the new
index and swaps it atomically, keeping the old one queryable throughout, so no downtime window is
needed. During the swap the index reports `status: BUILDING, queryable: true` and keeps serving the
old definition, which is why the update path also waits for `READY`.

### transactions_search_index (`search`)

```json
{
  "mappings": {
    "dynamic": false,
    "fields": {
      "text": { "type": "string" },
      "sender": { "type": "document", "fields": { "name": { "type": "string" } } },
      "recipient": { "type": "document", "fields": { "name": { "type": "string" } } }
    }
  }
}
```

The mapping is static. `dynamic: true` would index every field including the 1024-float embedding,
producing a large Lucene index over numbers nothing queries lexically. The three mapped paths are
exactly what the lexical pipeline and the `$rankFusion` lexical branch search.

Atlas has no update-in-place for a mapping change, so this index is create-only. Changing the
definition requires an explicit drop and rebuild: `RECREATE_SEARCH_INDEX=1 pnpm provision`. The
rebuild leaves the collection with no lexical index while it builds, which is why it is off by
default.

### policy_vector_index (`vectorSearch`)

```json
{
  "fields": [
    { "type": "vector", "path": "embedding", "numDimensions": 1024, "similarity": "cosine" },
    { "type": "filter", "path": "is_current_version" },
    { "type": "filter", "path": "category" }
  ]
}
```

Both filter paths are load-bearing. Governance filters on `is_current_version` to keep superseded
policy versions out of a live compliance check, and `category` narrows the search. A filter path
missing from the definition is an error at query time, not a silently ignored clause.

Definitions are compared by `(type, path)` rather than by array position, because order is not
significant to Atlas but is to `JSON.stringify`, and comparing by position would trigger a rebuild
every time the code reordered fields.

### policy_search_index (`search`)

```json
{ "mappings": { "dynamic": true } }
```

Dynamic here, unlike on `transactions`, because the collection holds 5 short documents with no vector
field worth excluding.

## Standard indexes

| Collection | Index | Options |
|---|---|---|
| `transactions` | `{transaction_id: 1}` | unique |
| `transactions` | `{created_at: -1}` | queue sort |
| `transactions` | `{status: 1}` | precedent and stats counts |
| `transactions` | `{'sender.account_number': 1}` | graph traversal |
| `transactions` | `{'recipient.account_number': 1}` | graph traversal |
| `agent_events` | `{transaction_id: 1, ts: 1}` | timeline reads |
| `policies` | `{policy_code: 1}` | unique, partial on `is_current_version: true`, named `policy_code_current_unique` |
| `session_resolutions` | `{sessionId: 1}` | |
| `session_resolutions` | `{decided_at: 1}` | `expireAfterSeconds: 86400` |

The two graph indexes are the only ones whose creation errors are not swallowed. A missing graph
index does not fail a ring trace, it silently degrades it to a collection scan per depth level, which
is the kind of failure that shows up as unexplained slowness rather than as an error.

## Money

`amount` is stored as `Decimal128`. Exactly one module knows this:
[`src/money.ts`](../src/money.ts). Everything else goes through its helpers (`toMoney`,
`moneyToNumber`, `compareMoney`, `moneyAtLeast`, `moneyAtMost`, `formatMoney`), scaled to 2 decimal
places with ROUND_HALF_UP.

Three traps are worth knowing before touching a code path that handles `amount`.

`z.number()` rejects it. `z.number().safeParse(Decimal128.fromString('1.00'))` is `false`, so a bare
numeric Zod field rejects every migrated document. `MoneySchema` is a union of a non-negative number
and a `Decimal128` refined to be finite and non-negative, because `Decimal128.fromString` accepts
`'NaN'` and `'Infinity'` and neither is money.

`JSON.stringify` emits `{"$numberDecimal": "…"}`, not a number. Any API response carrying a raw
`amount` shows this, which is why the evidence snapshot normalizes through `moneyToNumber`.

`Decimal128` is not value-canonical. `'1256'` and `'1256.00'` differ in bytes and are the same money,
so byte comparison and hashing over the raw value are both wrong. Comparison operators do work: a
bare `d >= 4900` gives the right answer because the operator stringifies and then coerces
numerically. What breaks is `===`.

## Embeddings

1024 dimensions, cosine similarity, from Voyage AI via the MongoDB-hosted gateway at
`https://ai.mongodb.com/v1` unless `VOYAGE_BASE_URL` overrides it. The model is `voyage-4`, set as
`EMBED_MODEL` in [`src/mastra/embed.ts`](../src/mastra/embed.ts). Documents are embedded in batches
of 96.

Vectors are stored as float32 `BinData` with Binary subtype 9, built by
[`src/data/embedding-codec.ts`](../src/data/embedding-codec.ts). The byte length is
`dims * 4 + 2`, or 4,098 at 1024 dims, where the 2 extra bytes are the dtype header.

Storage cost measured per document at 1024 dims: BSON `number[]` is 13,814 bytes, or 9.65 GB per
million. Float32 `BinData` is 4,605 bytes, or 3.22 GB.

Subtype 9 is mandatory, not a preference. One thousand documents stored as subtype 0 against a READY,
queryable index returned zero `$vectorSearch` hits and no error. The Zod schema checks subtype and
byte length rather than accepting any `Binary`, because a correctly-sized subtype-0 blob is silently
unsearchable, which is the worse failure. The decoder still reads legacy subtype 0 for documents
written before the migration.

Document and query embeddings are not interchangeable. Voyage's models are asymmetric, so seeding
uses `embedDocuments` and retrieval uses `embedQuery`. Embedding a stored document as a query put the
curated cases in a slightly different space from the synthetic corpus, making their retrieval scores
not directly comparable.

Changing `EMBED_MODEL` requires re-embedding the corpus in the same commit. Use `pnpm reembed` for the
migration.
