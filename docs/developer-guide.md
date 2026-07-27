# Developer guide

How the code is laid out, how to run the tests, and where to add things. For why the design is the way
it is, read [architecture.md](architecture.md) and the [ADRs](adr/README.md).

- [Repository layout](#repository-layout)
- [Running things](#running-things)
- [Tests](#tests)
- [Extension points](#extension-points)
- [Conventions](#conventions)

## Repository layout

```
src/
  config.ts              env parsing and validation, once, at startup
  money.ts               the only module that knows amount is a Decimal128
  server/                HTTP surface
    app.ts               Hono app, static file serving, startup, GET /api/health
    routes.ts            the other 14 endpoints
    session.ts           stateless HMAC bearer tokens
    change-stream-sse.ts one change stream, fanned out as SSE
    stats.ts             the cluster/quality rollup, cached
  workflow/              orchestration and durable state
    run-engine.ts        the per-case stage sequence and event emission
    investigate.ts       triage → reconcile → commit or suspend
    case-store.ts        the one ACID transaction per decision
    evidence.ts          the evidence snapshot and its hash
  decision/core.ts       triage() and reconcile(), pure and synchronous
  mastra/                the agent
    investigation-agent.ts  agent construction and the verdict call
    tools/                  the 5 bound tools
    tool-recorder.ts        tool-call events and the tool → operator map
    models.ts               provider selection and output ceilings
    embed.ts                Voyage embedding, model and batch size
    schemas/                Zod schemas and collection constants
  retrieval/
    service.ts           the retrieval API the tools call
    pipelines.ts         every aggregation shape lives here
  governance/
    reviewer.ts          policy retrieval plus the judge call
    judge.ts             the judge's structured output
    review.ts            grounding, scoring, threshold
    audit-chain.ts       HMAC chain primitives
    audit-store.ts       chain reads, appends, verification
    policies.ts          severities, threshold, collection constants
    resign-chain.ts      re-signing a chain under a new key
  data/
    provision-transactions.ts  index provisioning and version assertions
    seed-transactions.ts       curated and synthetic seeding
    synthetic-corpus.ts        the deterministic generator
    embedding-codec.ts         float32 BinData encode and decode
    replay-store.ts            replay collections and provenance
    replay-health.ts           staleness checks
  ingestion/             the 15 curated transactions and their lanes
  eval/metrics.ts        scoring
  observability/logger.ts
public/                  the console: vanilla ES modules, no build
scripts/                 provisioning, replay, benchmark, migration
deploy/                  Terraform and deploy scripts
docs/                    this documentation
data/replay/             the committed recording
```

About 8,300 lines of TypeScript under `src/`, plus 2,100 in `public/`.

Two structural rules are worth internalising before changing anything.

**Every aggregation shape lives in `src/retrieval/pipelines.ts`.** The functions there are pure: they
take parameters and return a pipeline array, with no database access. That is what makes the pipeline
shapes unit-testable without a cluster, and it is why the tests can assert that the lexical branch of
`$rankFusion` carries its status `$match`.

**`src/money.ts` is the only module that knows `amount` is a `Decimal128`.** Comparisons go through
`moneyAtLeast` and friends, conversions through `toMoney` and `moneyToNumber`. Adding a bare `>=` against
an amount elsewhere works today and is exactly the call site that breaks when the type changes.

## Running things

```bash
pnpm install
pnpm dev          # tsx src/server/app.ts
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run
```

Nothing compiles. `tsx` runs the sources directly, in development and in the container alike. See
[ADR 0010](adr/0010-no-build-step.md), including the part that matters here: `tsx` strips types without
checking them, so `pnpm typecheck` is a gate you have to run rather than one a failing build reminds you
about.

The console is served statically from `public/` by the same process. There is no bundler and no
framework, so a change to `public/app.js` is visible on reload.

## Tests

40 test files, `*.test.ts` beside the module they cover. `vitest`, no separate test build.

The suite runs with no cluster, no API key, and no network. That is a constraint on how code is
structured, not a property of the test runner: the pure parts are separated from the I/O so they can be
tested directly.

| Layer | Tested how |
|---|---|
| `decision/core.ts` | Every `triage` and `reconcile` branch called directly |
| `retrieval/pipelines.ts` | Pipeline arrays asserted structurally |
| `governance/review.ts`, `audit-chain.ts` | Pure functions, exact expected values |
| `money.ts` | Each documented `Decimal128` trap has a test |
| `workflow/*` | Injected fake `Db` recording writes |
| `server/routes.ts` | The Hono app with injected deps |
| `mastra/tool-recorder.ts` | Injected stepped clock |

Two testing habits in this repo are deliberate and worth copying.

**Inject the clock rather than sleeping.** `ToolCallRecorder` takes a `now` function, defaulting to
`Date.now`. Asserting a duration measured off the real clock means asserting a tolerance band, and a
band is only as sound as the machine's scheduler: three 12 ms sleeps overrun a 36 ms ceiling under
parallel workers on a loaded box, and the test fails on correct code. With a stepped clock the test
states the instants and the expected span follows by arithmetic.

**Assert the contract, not the artifact.** Tests over the committed replay fixtures assert shape and
invariants. Pinning incidental values turns every legitimate re-bake into a test failure, which happened
once and cost three tests.

## Extension points

### Adding an agent tool

Tools are defined in [`src/mastra/tools/retrieval-tools.ts`](../src/mastra/tools/retrieval-tools.ts) with
Zod input schemas. Five exist: `search_precedent`, `search_text`, `hybrid_search`, `trace_funds`,
`recall_verdicts`.

A new tool needs three things:

1. The tool definition, calling through `RetrievalService` rather than the driver directly.
2. Any new aggregation shape added to `pipelines.ts` as a pure function.
3. An entry in `TOOL_OPERATORS` in
   [`src/mastra/tool-recorder.ts`](../src/mastra/tool-recorder.ts), mapping the tool id to the MongoDB
   operator it uses and the capabilities it exercises.

That third one is not bookkeeping. The console's capability rail is an aggregation over recorded tool
events, so the operator label is how the app substantiates its own claims about which Atlas features ran.
A missing map entry degrades to an unlabelled row and logs a warning rather than failing the run, because
losing an investigation to a missing map entry would be the worse failure.

The hooks that record tool calls are awaited inline around each tool's `execute`, so anything slow in the
recorder lands on the agent's critical path. Keep it in memory; `run-engine.ts` does the writing after
the verdict is in hand.

### Adding a decision rule

Add it to `reconcile` in [`src/decision/core.ts`](../src/decision/core.ts) with a named constant, not a
literal at the call site. The invariant to preserve is the bound on auto-approval: after your rule, the
only route to an automatic `approve` must still be a clear-cut approve above the confidence ceiling that
matches no rule. A new rule that adds an escalate condition keeps that; one that returns `approve` on
any other path breaks it. Note that this is narrower than "reconcile may only tighten", which the code
comment used to claim and which the `low_confidence` branch already disproves. See
[ADR 0002](adr/0002-rules-bracket-the-llm.md).

If the rule involves an amount, compare through the money helpers.

### Adding a policy

Policies are seeded from [`src/governance/policies.ts`](../src/governance/policies.ts) with a code, text,
severity, and regulation citation, and are embedded at seed time. Severity is read from the stored record
at scoring time, never from the model, so adding a policy at `critical` genuinely changes the arithmetic.

The judge can only cite retrieved policies, so a new policy only has effect once retrieval surfaces it.
Check with the retrieval probe.

### Adding an endpoint

Endpoints are mounted in [`src/server/routes.ts`](../src/server/routes.ts). Two things to match:

Anything that mutates state must require a session, via `sidOf(c)`, and return 401 when it is null.
Session ids are derived only from a verified bearer token, never from a request body.

Anything that reads recorded run content must read through `recordingSource(cfg.demoMode)` rather than
naming `agent_events` or `audit_trail` directly, or demo mode will read live collections and a live run
will appear to corrupt the recording.

### Adding a watched collection

`WATCHED_COLLECTIONS` in
[`src/server/change-stream-sse.ts`](../src/server/change-stream-sse.ts) drives the live feed. Eight
collections are watched. Deletes are not forwarded, because they are maintenance operations with no
document to project.

### Changing the embedding model

`EMBED_MODEL` in [`src/mastra/embed.ts`](../src/mastra/embed.ts) is a constant, not an environment
variable, because it is a property of the stored corpus rather than of a deployment. Changing it means
re-embedding every stored vector in the same change: `pnpm reembed`, and the retrieval probe before and
after. A mismatch raises no error anywhere; retrieval just returns the wrong documents.

## Conventions

**TypeScript ESM throughout.** `type: module`, `strict: true`, relative imports with no extension,
resolved by `tsx` and by `moduleResolution: Bundler`.

**Comments explain why, and cite what was measured.** The module and field comments in this codebase are
long on purpose. They record the failure that motivated the code and, where a number decided something,
the number. That is the convention: a comment saying what the code does earns little, and one saying what
happened when it was written differently earns a lot.

**Constants are named and exported at the module that owns them.** `FEED_LIMIT`, `VECTOR_CANDIDATE_FLOOR`,
`MAX_DETAIL_CHARS`, `HIGH_VALUE_THRESHOLD`. A literal at a call site is a call site that gets missed.

**Failures degrade rather than cascade, and say which happened.** A missing operator map logs and
continues. A 40099 graph error returns an empty chain. A stats failure serves the stale cache. A missing
judge output holds the case. Each of those is a deliberate direction, and the ones that are not safe to
degrade, an unset production secret, an unsupported server version, fail startup instead.

**Nothing in a doc or a log line is a claim the code cannot substantiate.** The capability rail counts
recorded events. The stats bar counts documents. Latency figures carry the tier and model they were
measured on.
