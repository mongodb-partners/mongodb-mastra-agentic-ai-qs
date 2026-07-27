# Contributing

Thanks for looking at Marshal. This is a reference application, so a contribution is judged on whether
it makes the design clearer or more correct, not only on whether it works.

## Setup

```bash
pnpm install
cp .env.example .env    # set MONGODB_URI and VOYAGE_API_KEY
pnpm provision
pnpm dev
```

You need an Atlas cluster on 8.0 or later, because `$rankFusion` does. Full walkthrough:
[docs/getting-started.md](docs/getting-started.md).

## Before opening a pull request

```bash
pnpm typecheck
pnpm test
```

Both must pass. `pnpm typecheck` is not optional: `tsx` runs the sources without checking types, so a
type error will not stop the server from starting. See [ADR 0010](docs/adr/0010-no-build-step.md).

The test suite runs with no cluster, no API key, and no network. Keep it that way. If a change needs a
database to be tested, the usual fix is to separate the pure part, put the aggregation shape in
`src/retrieval/pipelines.ts` or the rule in `src/decision/core.ts`, and test that directly.

## What a good change looks like

**Read the code before changing it.** The module headers in this repo carry the reason the code is shaped
the way it is, and often the number that decided it. Several look like they could be simplified and cannot.

**State what you measured.** If a change is about performance, correctness at scale, or retrieval quality,
say what you ran, on what corpus size, and on what tier. A latency figure without a tier and a corpus size
is not checkable. Adding a second 1M-document vector index to one M30 moved an untouched index's p50 from
21.0 to 179.6 ms, which is how much the environment can matter.

**Do not add a setting that nothing reads.** There used to be an `RRF_K` variable, loaded and validated
and read by nothing. An operator tunes it, measures no change, and reasonably stops trusting the rest of
the configuration.

**Comments explain why.** A comment restating what the line does earns little. One recording the failure
that motivated the code earns a lot, and it is the convention here.

**Keep documentation in step.** A change to a public endpoint belongs in
[docs/api-reference.md](docs/api-reference.md), a new collection or field in
[docs/data-model.md](docs/data-model.md), and a new environment variable in
[docs/configuration.md](docs/configuration.md) *and* `.env.example`. A design decision that a reader would
otherwise have to reverse-engineer belongs in an [ADR](docs/adr/README.md).

## Invariants that need care

These hold across the codebase, and a change that breaks one needs to say so explicitly:

| Invariant | Where |
|---|---|
| `reconcile()` may only tighten a verdict, never relax it | [`src/decision/core.ts`](src/decision/core.ts) |
| Only `src/money.ts` knows `amount` is a `Decimal128` | [`src/money.ts`](src/money.ts) |
| Aggregation shapes are pure functions in one module | [`src/retrieval/pipelines.ts`](src/retrieval/pipelines.ts) |
| Recorded content is read through `recordingSource(demoMode)` | [`src/data/replay-store.ts`](src/data/replay-store.ts) |
| The judge may only cite retrieved policies, and missing output holds the case | [`src/governance/review.ts`](src/governance/review.ts) |
| State-mutating endpoints require a verified bearer token | [`src/server/routes.ts`](src/server/routes.ts) |
| A new tool has an entry in `TOOL_OPERATORS` | [`src/mastra/tool-recorder.ts`](src/mastra/tool-recorder.ts) |
| `snapshot.amount` is never converted to `Decimal128` | [`scripts/migrate-amount-decimal.ts`](scripts/migrate-amount-decimal.ts) |

[docs/developer-guide.md](docs/developer-guide.md) covers each of these with the reason behind it.

## Commits

Conventional commits, with a subject that says what changed rather than what was touched:

```
fix(governance): fail closed when the policy judge misses its structured output
test(recorder): assert an exact duration off a stepped clock, not a tolerance band
chore: drop the dead RRF_K setting and correct four stale references
```

Scopes in use: `server`, `governance`, `graph`, `retrieval`, `replay`, `recorder`, `ui`, `deps`,
`provisioning`, `export`, `terraform`, `audit`, `docs`, `test`, `chore`.

## Never commit

`.env` or any real credential. Only `.env.example`, with placeholders.

A recording baked with a production `AUDIT_SECRET`. The export path normalizes the chain to the dev secret
for this reason, but check the diff.

Real transaction data. Everything in this repo is synthetic and generated deterministically.

## Reporting a security issue

Do not open a public issue for a security problem. Use GitHub's private vulnerability reporting on this
repository.

## License

Contributions are made under the [Apache 2.0](LICENSE) license that covers this repository.
