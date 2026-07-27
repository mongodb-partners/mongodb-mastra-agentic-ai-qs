# ADR 0007: Vectors as float32 `BinData`, quantization chosen by corpus size

Status: accepted

## Context

Every transaction and policy document carries a 1024-dimension embedding. Two independent choices
follow: how the vector is stored in the document, and how the index represents it.

The path of least resistance is a BSON array of doubles for storage and one index setting for every
deployment. Both are wrong, and each is wrong for a different reason.

## Decision

**Storage: float32 `BinData`, Binary subtype 9.** A 1024-dim vector is written as `dims * 4 + 2` bytes,
4,098 of payload. The subtype is not decorative. Atlas requires 9 for a vector; subtype 0 is accepted by
the driver, stored without complaint, and returns zero `$vectorSearch` hits.

`BinData` is the target representation, not the only one in the collection. `TransactionSchema` accepts
either form, and the seed path writes plain `number[]`: `seedTransactions` and `seedSyntheticCorpus`
store what the embedder returns. The conversion helpers live in
[`src/data/embedding-codec.ts`](../../src/data/embedding-codec.ts), and the large-corpus loader in
`scripts/bench-corpus.ts` is what writes `BinData` today. Atlas indexes both, so a seeded deployment
searches correctly and pays the array-form storage cost. What the union does not accept is a subtype-0
`Binary` of the right length, which is the failure worth rejecting at the schema.

**Index representation: quantization by corpus size.** The index is built with
`quantization: 'binary'` at 100,000 documents or more and `'none'` below.

## Consequences

### Storage size is not a rounding error

Measured per document at 1024 dimensions:

| Representation | Bytes/doc | Per 1M docs |
|---|---|---|
| BSON `number[]` (doubles) | 13,814 | 9.65 GB |
| float32 `BinData` | 4,605 | 3.22 GB |

That is a 3x difference on the collection, which is the term that decides whether the working set fits
the tier. Nothing about the array form is better; it is only easier to write.

### The subtype is a silent failure mode

Subtype 0 versus subtype 9 produces no error anywhere. The document writes, the index reports READY and
queryable, and `$vectorSearch` returns an empty result set. Measured on 1,000 documents. A pipeline that
returns nothing looks like a corpus problem or a query problem, and the actual cause is two bytes in a
BSON header.

Related, and equally quiet: `status: READY` on a vector index does not mean the index has caught up.
During a 900,000-document top-up the index reported READY throughout. Gate on a self-match probe, not on
index status.

### One quantization setting for all sizes is wrong at one end

The verdict flips on whether the full-fidelity index fits in RAM, so it does not travel across corpus
sizes. Both ends were measured on an 8 GB tier.

At 1M documents a float32 index is about 4 GB beside a roughly 4.3 GB collection. It cannot stay
resident, novel queries page in HNSW nodes, and `$vectorSearch` alone measured p50 2,960 ms. Binary is 1
bit per dimension, 128 bytes per vector, about 128 MB resident. At `numCandidates` 400 it measured
recall 0.9830 at p50 34.4 ms, against float32's 0.9700 at 69.7 ms. Better recall and about 2x faster,
with a flat tail: p99/p50 of 1.15, where float32 blows out to 3.7 seconds.

At 12k documents the float32 index is about 49 MB, trivially resident, and recall is 1.0000 at every
candidate level. Binary can only match that, and below cand 400 it loses recall, 2.50 pp at cand 50 and
0.50 pp at cand 100, for roughly 2.5 ms of p50. Shipping binary at 12k would be a straight recall
regression for no gain the app can feel.

So binary is measured, real, and *not worth shipping at the scale this app seeds by default*. 12k is the
small end of the measured range, not the default: `SEED_SCALE_COUNT` is 1,200, an order of magnitude
below it and three below the threshold. That is the uncomfortable half of the result and the reason the
threshold exists rather than a flag.

### Consequences of the threshold itself

100,000 sits well above the default seeded corpus and well below 1M, so a typical deployment never lands
near the boundary. When a corpus does cross it, the index definition can be updated in place with no
downtime. The update body must be exactly `{"definition": {...}}`, and `queryable: true` is not
trustworthy during the swap.

The threshold is evaluated against the count at provisioning time, and `pnpm provision` provisions
before it seeds. On a fresh cluster the count is zero, so a run that then seeds 100,000 documents or more
leaves a `quantization: 'none'` index over a corpus that wanted binary. Re-running `pnpm provision`
against the populated collection fixes it: the code reads the live definition, compares, and patches in
place. Ordering it the other way, seed first, would leave the corpus unsearchable for the length of the
seed instead, which is worse for the common small-corpus path.

Verification of a binary index needs a different probe than a float32 one. ANN self-match measured 86 of
100 queries returning their own document at rank 1 on a healthy 1M binary index, because quantization
loses exactly the precision that separates a document from its near-identical neighbours. A self-match
gate on a binary index needs `exact: true` and a top-k window, and that is a brute-force scan, so it is
a provisioning check rather than a health check.

`numCandidates` has a single floor of 400 rather than a scale-aware value, because 400 measured best or
tied-best at both ends. At 12k it costs about 1.1 ms against cand 50, invisible next to an LLM-bound
investigation. At 1M it is what makes binary usable: binary walks the graph on 1-bit vectors and
rescores the shortlist at full fidelity, so too small a shortlist leaves nothing worth rescoring.
Measured at 1M, binary at cand 100 has a p99 of 1.9 seconds; at cand 200 it is 28.5 ms.

Attempts to derive an optimal `numCandidates` from a recall knee do not work at 1M, where recall never
plateaus, so a "within 0.5 pp of best" rule just returns the top of whatever grid was swept. 400 is the
honest operating point, not a discovered optimum.

The embedding model is not an environment variable, for the same reason as the storage format: it is a
property of the stored corpus, not of a deployment. Mixing models is not a degradation, it is a break:
querying a voyage-3.5 corpus with voyage-4 measured P@1 of 0.10, worse than random ranking, with no error
anywhere. Changing the model means re-embedding every vector in the same change.
