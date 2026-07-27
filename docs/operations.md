# Operations

How to run, seed, benchmark, and demo Marshal. Every script listed here is in `package.json`; the
details each one needs live in its own module header.

- [Every script](#every-script)
- [Provisioning and seeding](#provisioning-and-seeding)
- [The replay lifecycle](#the-replay-lifecycle)
- [Demo beats](#demo-beats)
- [Evaluation and retrieval quality](#evaluation-and-retrieval-quality)
- [Benchmarking](#benchmarking)
- [Migrations](#migrations)
- [Troubleshooting](#troubleshooting)

## Every script

| Script | What it does | Writes? |
|---|---|---|
| `pnpm dev` | Start the server (`tsx src/server/app.ts`) | no |
| `pnpm start` | Same command, used in the container | no |
| `pnpm test` | `vitest run`, 40 test files | no |
| `pnpm test:watch` | `vitest` in watch mode | no |
| `pnpm typecheck` | `tsc --noEmit` | no |
| `pnpm provision` | Full bringup: indexes, curated seeds, synthetic corpus, policies, self-check | yes, destructive to a live demo |
| `pnpm seed` | Alias of `pnpm provision` | yes |
| `pnpm sync:corpus` | Bring the synthetic corpus to `SEED_SCALE_COUNT` and touch nothing else | yes, corpus only |
| `pnpm reembed` | Re-embed every stored vector with the current model | yes, vectors only |
| `pnpm eval` | Score the pipeline against expected dispositions per lane | no |
| `pnpm bake` | Run the real agent over every pending case, then snapshot the recording | yes, destructive |
| `pnpm snapshot:replay` | Freeze the run already in the working collections | yes, `replay_*` only |
| `pnpm export:replay` | Write the `replay_*` collections to `data/replay/*.json` | no |
| `pnpm restore:replay` | Load `data/replay/*.json` back, re-sign the chain, health-check | yes, `replay_*` only |
| `pnpm check:replay` | Report whether the recording is still honest about this cluster | no |
| `pnpm beat:policy` | Touch a policy document, triggering the live-update banner | yes, one field |
| `pnpm beat:tamper` | Corrupt one audit field, triggering the broken-chain alarm | yes, one field |
| `pnpm beat:restore` | Undo the tampering | yes, one field |
| `pnpm bench:seed` | Seed the benchmark corpus in a separate cluster | yes, `marshal_bench` |
| `pnpm bench:export` | Stream the benchmark corpus to NDJSON plus a manifest | no |
| `pnpm bench:restore` | Load that NDJSON back without re-embedding | yes, `marshal_bench` |

There is also `scripts/retrieval-probe.ts` and `scripts/migrate-amount-decimal.ts`, run with `tsx`
directly rather than through a `package.json` script.

## Provisioning and seeding

`pnpm provision` is the full bringup, in order: assert `$rankFusion` support, provision the vector and
lexical search indexes, create the standard and graph indexes, upsert the 15 curated transactions, seed
the synthetic corpus to `SEED_SCALE_COUNT`, count decided precedents, run the search self-check, seed
policies and their indexes, provision `session_resolutions` with its 24-hour TTL, and warn if a
recording already on the cluster has gone stale.

Two things about it are worth knowing before running it against anything that is not a fresh cluster.

**It is destructive to a live demo.** Re-upserting the curated seeds rewrites the very documents a demo
narrates, and re-seeding policies fires the change stream's live-policy banner on every connected
console.

**Graph index failures are not swallowed.** The four standard indexes tolerate errors, because a
duplicate-index error is harmless. `provisionGraphIndexes` deliberately does not, because a missing
graph index does not fail a ring trace, it silently degrades it to a collection scan per depth level.

If the only thing you want to change is the corpus size, use `pnpm sync:corpus` instead. It calls
`seedSyntheticCorpus` and nothing else, with the same generator and the same document embedder, so the
vectors it writes are indistinguishable from the ones already there. It never touches the audit chain,
so it cannot produce a broken-chain banner.

```bash
SEED_SCALE_COUNT=12000 pnpm sync:corpus
```

The corpus is deterministic (`mulberry32` seeded at 42, ids `txn-syn-00001` upward), so record *i*
depends only on the RNG stream up to *i*. Raising the count re-derives the identical earlier documents.
Lowering it deletes the surplus, which is why the count is echoed before the write.

**`SEED_SCALE_COUNT` is a mass-delete lever on a large corpus.** On a cluster holding 1M synthetic
documents, any value other than the current one deletes down to it. The app and benchmark corpora share
the `txn-syn-` prefix, so this is not hypothetical.

A guard catches the worst version of that. A shrink of more than 1,000 documents throws instead of
deleting, which is exactly the shape of a re-provision run against a large corpus with a small
`SEED_SCALE_COUNT`. Set `SEED_SCALE_COUNT=0` to leave the corpus alone. To shrink on purpose, say so:

```bash
ALLOW_SHRINK=1 SEED_SCALE_COUNT=1200 pnpm sync:corpus
```

`ALLOW_SHRINK` is read by `pnpm sync:corpus` only. `pnpm provision` has no way to pass it, so a large
shrink from the provision path always fails.

### Re-embedding

`pnpm reembed` exists because the seeders are incremental. `seedSyntheticCorpus` skips ids that already
exist, so after an embedding-model change a plain reseed leaves the whole synthetic corpus holding
vectors from the old model while queries use the new one. Dimensions still match at 1024, so nothing
errors and retrieval just gets quietly worse.

It covers both embedded collections, `transactions` and `policies`, re-embedding from each document's own
stored source text. No narrative is regenerated and no id changes.

```bash
pnpm reembed --dry-run   # report counts without writing
pnpm reembed
```

Measure before and after with the retrieval probe, described below. A model mismatch is not a
degradation, it is a break, and it raises no error. See
[ADR 0007](adr/0007-vector-storage-and-quantization.md).

## The replay lifecycle

Five scripts, and choosing the wrong one destroys a recording that cannot be regenerated, because model
output is not reproducible.

```
pnpm bake ─────────────┐
  (clear, investigate, │
   snapshot)           ├──► replay_* collections ──► pnpm export:replay ──► data/replay/*.json
pnpm snapshot:replay ──┘                                                          │
  (snapshot only)                                                                 │
                          replay_* collections ◄──── pnpm restore:replay ◄────────┘
                                                       (+ re-sign, + health check)
```

**`pnpm bake`** does three things: clear prior run state, investigate every pending case with the real
LLM, snapshot the result into `replay_*`. The first of those is a `deleteMany({})` across six
collections. That makes bake the right tool for producing a recording on a scratch cluster and the wrong
tool for capturing one that already happened.

**`pnpm snapshot:replay`** is bake without the destructive half. Use it when the run worth keeping is one
a live deployment just produced. It is read-only with respect to the working collections. It refuses to
run when `DEMO_MODE` is on, because there the working collections are not where the recording lives, so a
snapshot would copy unused live-run state over the good recording. Almost certainly nothing, which is
worse than failing, because it would blank the replay silently.

Both accept provenance flags, both optional and both recorded as `'unknown'` when omitted:

```bash
pnpm snapshot:replay --commit "$(git rev-parse --short HEAD)" --tier M30
```

Pass `--commit` explicitly when running in the container, because the image excludes `.git`.

**`pnpm export:replay`** writes the `replay_*` collections plus `replay_meta` to `data/replay/` as
Extended JSON, so ObjectIds, Dates, and insertion order survive the round trip. Order and `_id` matter,
because the audit chain is verified in `_id` order.

The export normalizes the audit chain to the dev secret on the way out. That is not cosmetic. A bake that
ran on a deployed box under that box's `AUDIT_SECRET` produced an artifact that restored cleanly to that
box and aborted on any other with `hmac_mismatch` links. Normalizing makes the artifact independent of
whichever box baked it, which is the property a committed recording is supposed to have. An artifact that
verifies under neither key aborts the export rather than being laundered.

The abort only fires when there is a re-signing to do. Both the export and the restore short-circuit
when the active `AUDIT_SECRET` is already the dev secret, which is the usual local case, and the
short-circuit skips verification along with the re-signing. So a tampered chain baked and exported on a
dev-secret box passes both steps quietly, and the first thing that notices is `/api/audit/verify` on a
box with a real secret. Run the verify endpoint after a bake if the chain matters to you.

**`pnpm restore:replay`** loads the JSON back and runs two fences automatically, because the raw restore
alone has repeatedly produced a broken-looking demo on a fresh box:

1. The chain is re-signed under this deployment's `AUDIT_SECRET`. Without this, a box with a real secret
   shows a broken chain on an untampered ledger.
2. `checkReplayHealth` warns when the recording has gone stale against this cluster.

`--strict` turns the health warnings into a non-zero exit, for CI.

Run `pnpm provision` first. Restore only writes the recording; the transactions and policies it
references have to exist.

**`pnpm check:replay`** runs the same health check on demand. Run it whenever the corpus size, embedding
model, or pipeline speed changes, since those are the three things that make a frozen recording start
lying and none of them touch the recording itself. It reports precedent ids the recording cites that no
longer exist, timings the live pipeline has since beaten, and pacing gaps the client's floors have taken
over.

Two of the three are checked directly; the embedding model is not. `replay_meta` records `llm_model` but
no embedding model, so the check has nothing to compare `EMBED_MODEL` against. What it does catch is the
consequence: a re-embedded corpus surfaces different precedents, so the ids the recording cites stop
resolving and show up as dangling. Re-bake after a model change rather than relying on the check to tell
you to.

```bash
pnpm check:replay --live-span-ms 8400
```

`--live-span-ms` supplies a current live-run wall clock so the timing check can judge rather than just
report. Get it from a live box as the span of one `run_id` in `agent_events`. Read-only, and non-zero on
staleness, so it works as a pre-demo gate.

Recorded timings do go stale. The replay paces off the recorded timestamp deltas, so as the live path
gets faster the demo looks slower than the product.

## Demo beats

Three scripts that make the console react. Each is a real database write; nothing is staged client-side.

| Script | Effect |
|---|---|
| `pnpm beat:policy` | Touches a policy document, so every console shows a live policy update |
| `pnpm beat:tamper` | Corrupts one audit record's `event_type`, so the chain chip goes red |
| `pnpm beat:restore` | Restores it, so the chain verifies again |

The audit beats are mode-aware: they target `audit_trail` in live mode and `replay_audit` in demo mode,
restoring afterwards so the recording returns to its baked state. Run them with the same `DEMO_MODE` as
the server, or they will target the collection the console is not verifying.

In demo mode the chip does not turn red on its own. The client re-checks the chain when a change event
arrives on `audit_trail`, and `WATCHED_COLLECTIONS` does not include `replay_audit`, so a demo-mode
tamper is invisible until something re-fetches `/api/audit/verify`: a page reload does it, since the chip
is checked on load. `/api/audit/verify` reads the right collection for the mode, so the verdict is
correct once fetched. The live-mode beat reacts immediately.

## Evaluation and retrieval quality

`pnpm eval` runs the decision path over the live curated cases, one per lane, and scores the final
disposition against the expected one:

| Lane | Expected |
|---|---|
| `clean_approve` | approve |
| `clear_reject` | reject |
| `structuring` | escalate |
| `high_value` | escalate |
| `ring` | escalate |
| `sanctions` | reject |

The gate that matters is fraud recall, held at 1.0. Letting a fraud case auto-approve is the costly
error; a false escalate costs a human a minute.

It scores the agent, `traceFunds`, and the two rule passes. Governance, the commit transaction, and the
audit append are not in the loop, so a compliance regression does not show up here. `pnpm test` covers
those parts directly.

`scripts/retrieval-probe.ts` is the comparative check for retrieval quality. It runs six probe queries
whose correct lane is known and reports precision@5 over lane labels, with no LLM involved, so it is
fast and deterministic enough to compare across runs.

```bash
npx tsx scripts/retrieval-probe.ts
npx tsx scripts/retrieval-probe.ts --model=voyage-3.5   # embed queries with the OLD model
```

That `--model` flag exists so a before-and-after comparison across an embedding change is
apples-to-apples: old model against old corpus, rather than new queries against old document vectors,
which is the broken state you are trying to avoid rather than a baseline.

## Benchmarking

The benchmark corpus lives in its own database and its own cluster, addressed by `BENCH_MONGODB_URI`,
which all three `bench:*` scripts require explicitly.

```bash
BENCH_MONGODB_URI=… pnpm bench:seed    -- --count 1000000
BENCH_MONGODB_URI=… pnpm bench:export  -- --out /data/bench-1m.ndjson
BENCH_MONGODB_URI=… pnpm bench:restore -- --in  /data/bench-1m.ndjson
```

Export before sweeping, not after. Embedding is the only expensive step, roughly 0.6 hours per million
through the gateway. A bad sweep, a wrong index, or a dropped collection should never cost the embedding
run again.

Two rules about where you run a benchmark, both learned by getting the wrong answer first:

**Run it on a box in the same region as the cluster, never from a laptop.** The WAN leg is roughly 250 ms
and it inverts model and index comparisons.

**Do not reuse one query set across runs.** That measures a warm cache rather than the operation. Order
matters too: whichever shape runs first pays the cold cost.

Vector index memory dominates cluster sizing, and workloads interact. Adding a second 1M-document vector
index to one M30 moved an untouched index's p50 from 21.0 to 179.6 ms. Any latency figure needs the tier
it was measured on, which is why the benchmark manifest and `replay_meta` both carry it.

## Migrations

`scripts/migrate-amount-decimal.ts` converts `amount` from int32 to `Decimal128` in place without
changing any value. The database name is required and never defaulted:

```bash
MONGODB_URI=… npx tsx scripts/migrate-amount-decimal.ts --db marshal --dry-run
MONGODB_URI=… npx tsx scripts/migrate-amount-decimal.ts --db marshal
```

It is idempotent: a second pass reports zero modifications. Values are preserved exactly, which is what
makes it cheap. The narrative `text` is untouched, so every embedding, the vector index, and any exported
benchmark artifact stay valid. A migration that changed amounts would invalidate every embedding, since
the amount is interpolated into `text`.

It deliberately does not touch `snapshot.amount` in `reviews` and `case_analysis`. That field is bound
into `evidence_hash`, and converting it changes the digest, after which every future attempt to resolve
the case is rejected as stale. A test asserts its absence from the path list. See
[ADR 0008](adr/0008-decimal128-money.md).

## Troubleshooting

**A connection hangs and then fails with `ENETUNREACH`.** Your public IP is not on the Atlas project
access list. Home and office IPs rotate.

**`$vectorSearch` returns nothing against a READY index.** Check the `BinData` subtype. Atlas requires
subtype 9 for a vector; subtype 0 stores without error and returns zero hits. Also note that `READY`
does not mean caught up: during a 900,000-document top-up the index reported READY throughout. Gate on a
self-match probe.

**The console shows a broken audit chain.** Read the reason from `/api/audit/verify`. `key_mismatch`
means the records were signed under a different `AUDIT_SECRET`, which is what happens when a deployment
restores a recording and then sets a fresh secret. `hmac_mismatch` with a matching key id means the
content actually changed. `chain_link_broken` means a record's previous-hash pointer does not match.

**Aggregation error 40099 on a graph trace.** That is the 100 MB in-memory aggregation ceiling, not the
16 MB BSON limit. It does not spill to disk, so no projection and no tier change avoids it. Depth is
capped at 3 for this reason, and the retrieval service tolerates 40099 specifically, returning an empty
chain rather than failing the case.

**Replay chips open onto nothing.** The recording cites precedent ids that no longer exist on this
cluster, usually after a reseed at a different `SEED_SCALE_COUNT`. `pnpm check:replay` names them. The
recording is what needs fixing, not the seed run.

**A dependency looks patched but the alert persists.** Check the lockfile, not just `package.json`, and
verify inside the running container. A patched direct dependency can coexist with an older copy that
shipped in the image, and Mastra vendors AI-SDK majors under aliased package names, so an override on the
plain name does not reach them.
