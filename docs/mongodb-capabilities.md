# MongoDB capabilities in Marshal

Eight capabilities, one cluster, no second datastore. This document maps each capability to the
operator that implements it, the code that builds the query, and what was measured.

The console's capability rail is not a copy claim. Each recorded tool event stores the operator that
served it, and the rail is an aggregation over those stored events, so it counts work that actually
ran.

| Capability | Operator or feature | Where |
|---|---|---|
| Vector search | `$vectorSearch` | [`src/retrieval/pipelines.ts`](../src/retrieval/pipelines.ts) |
| Full-text search | `$search` (BM25 over Lucene) | same |
| Hybrid retrieval | `$rankFusion` | same |
| Graph traversal | `$graphLookup` | same |
| Agent memory | `$vectorSearch` over decided cases | [`src/retrieval/service.ts`](../src/retrieval/service.ts) |
| Governance | `$vectorSearch` over `policies` | [`src/governance/reviewer.ts`](../src/governance/reviewer.ts) |
| Durable workflow state | Multi-document ACID transactions | [`src/workflow/case-store.ts`](../src/workflow/case-store.ts) |
| Audit trail | Append-only HMAC hash chain | [`src/governance/audit-chain.ts`](../src/governance/audit-chain.ts) |
| Live UI | Change streams projected as SSE | [`src/server/change-stream-sse.ts`](../src/server/change-stream-sse.ts) |

Every number below was measured on this corpus, at the corpus size stated. Numbers from a laptop are
not included, because the WAN leg is roughly 250 ms and inverts conclusions.

## Vector search

`$vectorSearch` over the `embedding` path of `transactions`, cosine similarity, 1024 dimensions,
filtered to decided cases inside the operator rather than after it.

```js
{
  $vectorSearch: {
    index: 'transactions_vector_index',
    path: 'embedding',
    queryVector: qvec,
    numCandidates: Math.max(400, limit * 10),
    limit,
    filter: { status: { $in: ['approved', 'rejected', 'escalated'] } },
  },
}
```

The index is built on the operational collection. There is no separate embedding collection, so the
document a query ranks is the document the agent then reads and the pipeline then updates.

### The candidate floor

`numCandidates` has a floor of 400, which is one value for every corpus size rather than a
scale-aware knob. It measured best or tied-best at both ends of the range this app is built for:

| Corpus | Index | recall@10 at cand 400 | p50 at cand 400 |
|---|---|---|---|
| 1M | binary | 0.9830 | 34.4 ms |
| 12k | float32 | 1.0000 | 7.6 ms |

At 12k the floor costs about 1.1 ms against cand 50, which is invisible next to an LLM-bound
investigation. At 1M it is what makes a binary index usable at all: binary walks the graph on 1-bit
vectors and then rescores the shortlist against full-fidelity ones, so too small a shortlist leaves
nothing worth rescoring. Measured at 1M, binary at cand 100 has a p99 of 1.9 seconds; at cand 200 it
is 28.5 ms. Raising the floor is cheap. Lowering it below 200 reopens that tail.

Benchmarks that sweep `numCandidates` pass it explicitly, and an explicit value is honoured as given.
Only the default is floored.

### Quantization is chosen by corpus size

The vector index is built with `quantization: 'binary'` at 100,000 documents or more, and `'none'`
below. The verdict depends on whether the full-fidelity index fits in RAM, so it does not travel across
corpus sizes. Measured on an 8 GB tier, at cand 400:

| Corpus | float32 | binary |
|---|---|---|
| 1M | recall 0.9700, p50 69.7 ms, p99 3.7 s | recall 0.9830, p50 34.4 ms, p99/p50 1.15 |
| 12k | recall 1.0000, p50 7.6 ms | ties on recall, about 2.5 ms faster |

At 1M the float32 index is about 4 GB beside a 4.3 GB collection, so it cannot stay resident and novel
queries page in HNSW nodes; binary is 128 bytes per vector, about 128 MB. At 12k float32 is 49 MB and
already returns recall 1.0000, so binary has nothing to win and loses 2.50 pp at cand 50. Both ends and
the arithmetic behind them are in [ADR 0007](adr/0007-vector-storage-and-quantization.md).

The threshold sits well above the default seeded scale (`SEED_SCALE_COUNT` is 1,200) and well below 1M,
so a typical deployment never lands near the boundary. When it does cross, the definition is updated in
place with no downtime. Provisioning runs before seeding, so crossing the threshold in a single fresh
`pnpm provision` needs a second run to pick up the new size.

### A vector index can be READY and still wrong

Two failure modes are worth knowing because neither reports an error.

A vector stored as Binary subtype 0 instead of subtype 9 returns zero `$vectorSearch` hits against a
READY, queryable index, with no error. Measured on 1,000 documents.

`status: READY` does not mean caught up. During a 900,000-document top-up the index reported READY
throughout. Gate on a self-match probe instead of on index status. Note that on a binary index the
probe needs `exact: true` and a top-k window: ANN self-match measured 86 of 100 queries returning
their own document at rank 1 on a perfectly healthy 1M index, because quantization loses exactly the
precision that separates a document from its near-identical neighbours.

## Full-text search

`$search` with a `text` operator over three paths.

```js
{ $search: { index: 'transactions_search_index',
             text: { query, path: ['text', 'sender.name', 'recipient.name'] } } }
```

The index mapping is static (`dynamic: false`). It used to be dynamic, which indexed every field
including the 1024-float embedding, producing a large Lucene index over numbers nothing ever queries
lexically. The three mapped paths are exactly what this pipeline and the `$rankFusion` lexical branch
search.

Atlas has no update-in-place for a mapping change, so this index is create-only and changing it needs
an explicit drop. See [configuration.md](configuration.md#provisioning-only) for
`RECREATE_SEARCH_INDEX`.

## Hybrid retrieval

`$rankFusion` runs the vector and lexical branches server-side and fuses them by reciprocal rank.
There is no client-side merge and no fusion constant to tune, because MongoDB fixes it server-side.

```js
{
  $rankFusion: {
    input: { pipelines: {
      vector:  [ { $vectorSearch: { …, numCandidates: 400, limit: perBranch, filter: { status: { $in: DECIDED } } } } ],
      lexical: [ { $search: { … } }, { $match: { status: { $in: DECIDED } } }, { $limit: perBranch } ],
    } },
  },
}
```

`perBranch` is `max(k * 4, 20)`. The app calls it with k=4.

The `$match` on the lexical branch mirrors the vector branch's filter. Without it a pending case
could be fused in as its own precedent, since `$search` has no in-operator filter to carry the
constraint.

### This is the number to quote

Measured over 300 investigations at k=4. Neither column is the default corpus: `SEED_SCALE_COUNT` seeds
1,200 documents, below the small end here.

| Leg | 12k p50 | 1M p50 |
|---|---|---|
| Hybrid (`$rankFusion`) | 34.2 ms | 171.6 ms |
| Vector branch alone | 4.1 ms | 11.0 ms |
| Lexical branch alone | 12.6 ms | 27.4 ms |

Tail at 1M: p95 231.8 ms, p99 255.5 ms, so p99 is 1.49x p50. An 83x larger corpus costs 5.0x the
median and 3.6x the p99.

Benchmarking `$vectorSearch` alone understates the retrieve stage that actually ships by about 8x at
12k and 15.6x at 1M. Fusion runs both branches and pays for the slower one plus the merge, so the
vector-only figure is not a proxy for it.

Two benchmarking traps produced misleading versions of this table before it was right. Reusing one
query set across runs measures a warm cache, not the operation. And ordering matters within a run:
whichever shape runs first pays the cold cost. Novel-query cost at 1M was roughly 300 ms until binary
quantization landed; the cache effects are permanent properties of the measurement, not of the
system.

## Graph traversal

`$graphLookup` follows `sender.account_number` to `recipient.account_number` to surface a fund-flow
network, then `summarizeRing` turns the chain into ring signals.

```js
[
  { $match: { 'sender.account_number': accountId } },
  { $limit: 1 },
  { $graphLookup: {
      from: 'transactions',
      startWith: '$recipient.account_number',
      connectFromField: 'recipient.account_number',
      connectToField: 'sender.account_number',
      as: 'chain', maxDepth: 3, depthField: 'depth',
  } },
  { $project: { _id: 0, 'chain.sender.account_number': 1, 'chain.recipient.account_number': 1,
                'chain.amount': 1, 'chain.depth': 1 } },
]
```

Ring signals: `circular_flow` when any edge returns to the seed account, `layering` when three or
more transfers are under $1,000, and `suspicious_patterns` when either holds or the network has three
or more edges.

Every part of that pipeline earns its place, and two of them are load-bearing only at scale.

`$limit: 1` bounds the anchor. A seed account has around 100 transactions and each one otherwise
seeds its own full closure, all identical. Measured 185 ms down to 51 ms. It does not help with size:
a chain that overflows a limit fails byte-identically with or without it.

The `$project` keeps the chain under the 16 MB BSON limit. The optimizer pushes it into
`$graphLookup`, so the chain is never materialized at full document width: 13,736 bytes per edge,
dominated by the embedding, drops to 115. Verified against a chain that is 40.7 MB unprojected, which
fails without the projection and succeeds with it. The 16 MB limit is a protocol constraint and no
Atlas tier raises it.

Keep the projected field list in sync with what consumers read. `summarizeRing` uses both account
numbers and `amount`, and the UI renders `depth`. Dropping a field here silently empties part of a
ring.

### The projection is necessary and not sufficient

At 1M documents the projection alone does not save you. A uniform-random account topology makes the
depth-3 closure reach essentially every account, which is about 102 MB even projected. The corpus
topology has to be clustered as well: communities of 50 accounts with a low bridge rate bring the 1M
worst case to 4.39 MB. Those constants live in
[`src/data/synthetic-corpus.ts`](../src/data/synthetic-corpus.ts).

There are two separate limits here and confusing them wastes a day. The 16 MB cap is the BSON
document limit. The other is a 100 MB in-memory aggregation ceiling reported as error 40099, which
does not spill to disk, so no projection and no tier change makes it go away.

That ceiling is why the agent's `trace_funds` tool caps depth at 3. Measured at 1M with an unbounded
sender, depth 4 hit 40099 on about 15% of calls, depth 5 on 40%, depth 6 on 50%; successful calls
measured p50 1.2 s and p99 3.4 s. The retrieval service tolerates 40099 specifically and returns an
empty chain rather than failing the case.

### Depth is bounded, and the app's real path is cheap

The measured graph numbers split sharply by which account you start from:

| Path | 1M p50 | Notes |
|---|---|---|
| Random sender accounts | 1,189.5 ms | 1 call in the sample hit 40099 |
| The app's pending-case path | 1.7 ms | What actually runs per case |

Chain sizes differ the same way: a random sender reached a maximum of 18,939 edges, while the app's
pending path reached 4. The app traces the sender of a case under review, and those accounts are not
hubs. Benchmarking `$graphLookup` on random accounts measures a workload this app does not have.

## Agent memory

The same `$vectorSearch`, aimed at prior decided cases and their dispositions. It is a distinct
capability in the rail because the question is different: not "which cases are similar" but "how were
similar cases resolved". The `recall_verdicts` tool serves it, and the run engine also records the top
two precedent dispositions as a `recall` step.

## Governance

`$vectorSearch` over `policies`, filtered to `is_current_version: true`, returning up to 5.

The retrieval is the smaller half. What makes governance trustworthy is what happens to the result:

The judge may only cite policies that were retrieved. Anything else is dropped and recorded in
`dropped_citations`. A model cannot invent a regulation to justify a hold.

Severity comes from the stored policy record, not from the model's classification, so a judge calling
a critical rule "low" cannot under-penalize. Scoring is arithmetic: 1.0 minus the summed penalties
(`low` 0.05, `medium` 0.15, `high` 0.25, `critical` 0.4), held below 0.7.

If the judge produces no valid structured output after 3 attempts, the case is held with a compliance
score of 0. See [ADR 0004](adr/0004-grounded-fail-closed-governance.md) for why the alternative is
dangerous rather than merely lossy.

## Durable workflow state

One multi-document ACID transaction per decision. Inside a single `withTransaction`: insert the
immutable decision, flip the transaction status, upsert the case, and append the audit link.

The audit append runs fully inside that transaction, with the tail read session-scoped. That is what
makes the chain safe under concurrency: two transactions reading the same tail conflict on write, and
one aborts and retries against the new tail, instead of both chaining to it and forking the chain.

A held case is durable in a different sense. The evidence snapshot and its hash are persisted, and a
human verdict arriving minutes or days later re-derives the hash from current state before committing.
Drift is refused as stale rather than committed against evidence the reviewer never saw.

`MONGODB_URI` must point at a replica set for any of this. Transactions and change streams both
require one.

## Live UI

One change stream over eight collections, fanned out to every connected browser as SSE. Not one
stream per viewer.

Watched: `transactions`, `cases`, `case_decisions`, `reviews`, `audit_trail`, `agent_events`,
`case_analysis`, `policies`. The last one powers a live policy edit: change a policy document and
every connected console reacts.

Reconnect resumes from the last token with a backoff of 250, 1000, 2500, 5000, then 10000 ms. The
early retries are the ones that matter, because a replica-set election completes in about 10 to 12
seconds; the ceiling exists so a genuinely unreachable cluster settles into a slow poll instead of
hammering. A resume token the cluster can no longer honour fails identically on every retry, so
`ChangeStreamHistoryLost` (286) and `InvalidResumeToken` (260) drop the token and reconnect without
it rather than retrying into the same failure forever.

The backoff resets on a received change, not on a successful open, because a stream can open and then
immediately fail. Only data proves it works.

## What this adds up to

The stage-share measurement is the honest frame for all of the above. Share of wall-clock per case:

| Stage | Share |
|---|---|
| Agent reasoning | 45.0% |
| Agent tool calls | 30.4% |
| Governance | 16.1% |
| Retrieve | 7.6% |
| Graph | 0.5% |

The model is 91.5% of a case. Atlas is 8.1%. The retrieval work in this repo is therefore aimed at
correctness and at not falling off a cliff at scale, not at shaving milliseconds off a stage that is
already a rounding error.

The claim worth making is the one about consolidation: eight capabilities, one connection string, one
thing to secure and back up and reason about. Not that the aggregations are fast, though at these
sizes they are.
