# ADR 0003: `$rankFusion` server-side instead of client-side RRF

Status: accepted

## Context

Precedent retrieval needs both semantic and lexical matching. Semantic search finds a structuring
pattern described in different words. Lexical search finds an exact account number, a merchant name, or
a reference code, which an embedding blurs.

The usual way to combine them is client-side reciprocal rank fusion: run two queries, receive two
ranked lists, merge them in application code with `score = sum(1 / (k + rank))`. It is a dozen lines and
it works.

It also introduces a constant, `k`, that has to be tuned, and a merge step that has to be tested. The
constant is the part that ages badly. It is easy to expose as configuration, hard to tune honestly, and
nobody revisits it.

## Decision

Use MongoDB's `$rankFusion` and let the server do the fusion.

`buildRankFusionPipeline` in [`src/retrieval/pipelines.ts`](../../src/retrieval/pipelines.ts) emits one
aggregation with two named input pipelines, `vector` and `lexical`. Each branch is limited to
`perBranch = max(k * 4, 20)` documents before fusion. The application receives one ranked list.

There is no `RRF_K` setting. `$rankFusion` does not expose the constant; MongoDB fixes it server-side.
Fusion weighting is expressed instead through the per-branch limits, which are visible in the pipeline
rather than hidden in an env file.

The lexical branch carries an explicit `$match` on `status` after `$search`, mirroring the `filter`
inside `$vectorSearch`. `$search` has no in-operator filter, so without the `$match` a pending case
could be fused in as its own precedent.

## Consequences

One round trip instead of two, and one place where the query shape lives.

`$rankFusion` requires MongoDB 8.0 or later. Provisioning asserts the server version explicitly with a
clear message, because the failure at query time is not obviously a version problem.

A previous version of this repo did ship an `RRF_K` variable. It was loaded, validated, and read by
nothing. That is worse than having no knob: an operator tunes it, measures no change, and reasonably
stops trusting the rest of the configuration. It has been removed and the reason is documented in
[configuration.md](../configuration.md#not-a-setting-rrf_k) so it does not come back.

Fusion costs more than either branch, and the number worth quoting is the fused one. Measured over 300
investigations at k=4:

| Leg | 12k p50 | 1M p50 |
|---|---|---|
| Hybrid (`$rankFusion`) | 34.2 ms | 171.6 ms |
| Vector branch alone | 4.1 ms | 11.0 ms |
| Lexical branch alone | 12.6 ms | 27.4 ms |

Benchmarking `$vectorSearch` alone understates what ships by about 8x at 12k and 15.6x at 1M. Fusion
runs both branches and pays for the slower one plus the merge.

The tuning surface is smaller but not gone. Instead of one opaque constant there are the per-branch
limits and `numCandidates`, both of which are measurable against recall on a real query set. That is
the trade accepted here: less to tune, and what remains is tunable against evidence.
