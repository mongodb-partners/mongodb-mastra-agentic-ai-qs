# Marshal: Fraud Investigation Console (MongoDB + Mastra)

An agentic fraud/claims investigation console built on **MongoDB Atlas + Mastra**. A Mastra
agent investigates each flagged transaction, and every capability runs on a single Atlas
cluster: `$vectorSearch`, `$search`, `$rankFusion` hybrid retrieval, `$graphLookup` fund-tracing,
policy governance, durable human-in-the-loop workflow state, and a tamper-evident audit chain.

The design property worth reading the code for is where the LLM is *not* allowed to be.
Deterministic rules run before the model and after it, and only those rules decide: a sanctions hit
short-circuits before any token is spent, and post-model reconciliation may only ever tighten a
verdict. See [docs/architecture.md](docs/architecture.md).

## Capabilities on one cluster

| Capability | Operator or feature | Where |
|---|---|---|
| Vector search | `$vectorSearch` | [`src/retrieval/pipelines.ts`](src/retrieval/pipelines.ts) |
| Full-text search | `$search` (BM25 over Lucene) | same |
| Hybrid retrieval | `$rankFusion`, fused server-side | same |
| Graph traversal | `$graphLookup` fund tracing | same |
| Agent memory | `$vectorSearch` over decided cases | [`src/retrieval/service.ts`](src/retrieval/service.ts) |
| Governance | `$vectorSearch` over `policies` | [`src/governance/reviewer.ts`](src/governance/reviewer.ts) |
| Durable workflow state | Multi-document ACID transactions | [`src/workflow/case-store.ts`](src/workflow/case-store.ts) |
| Audit trail | Append-only HMAC hash chain | [`src/governance/audit-chain.ts`](src/governance/audit-chain.ts) |
| Live UI | Change streams projected as SSE | [`src/server/change-stream-sse.ts`](src/server/change-stream-sse.ts) |

No vector database, no search cluster, no sync job. The vector index is built on the operational
`transactions` collection, so a retrieval hit is the same document the agent then reads.

## Quick start

```bash
pnpm install
cp .env.example .env    # set MONGODB_URI and VOYAGE_API_KEY
pnpm provision          # create indexes, seed cases, and the synthetic precedent corpus
pnpm dev                # API on http://localhost:8000
curl localhost:8000/api/health
```

`MONGODB_URI` must point at a replica set (the app uses change streams). The cluster must be on
MongoDB 8.0 or later, which `$rankFusion` requires and `pnpm provision` asserts. See `.env.example`
for all options, or [docs/configuration.md](docs/configuration.md) for what each one does.

Nothing compiles: `tsx` runs the TypeScript sources directly, in development and in the container
alike.

## Modes

- **Live** (default): the Mastra agent runs over every pending case; the UI is a projection of
  MongoDB change streams over the working collections.
- **Demo** (`DEMO_MODE=1`): replays a pre-baked recording — no runtime LLM. To seed a fresh
  cluster from the committed recording:
  ```bash
  pnpm provision
  pnpm restore:replay     # load data/replay/*.json into the replay_* collections
  DEMO_MODE=1 pnpm dev
  ```

Demo and live are isolated: demo reads only the `replay_*` collections; live runs and resets
touch only the working collections.

## What it measures

A case takes about 10 seconds, and most of that is the model. Retrieval is milliseconds against a
model doing seconds, which is why the database work here targets correctness and scale rather than
shaving milliseconds. The `stage_share` field on `/api/stats` supports that direction and nothing
finer: its per-stage labels are off by one, for the reason given under
[known limits](docs/architecture.md#known-limits). Earlier revisions of this file quoted them as a
measured split.

Hybrid retrieval, over 300 investigations at k=4. Both corpora are larger than the 1,200 documents
`pnpm provision` seeds by default:

| Corpus | `$rankFusion` p50 | Vector branch alone |
|---|---|---|
| 12k documents | 34.2 ms | 4.1 ms |
| 1M documents | 171.6 ms | 11.0 ms |

Benchmarking the vector leg alone understates the retrieval stage that actually ships by about 8x at
12k and 15.6x at 1M, because fusion runs both branches. Every figure in the docs states the corpus
size it was measured at, and latency figures state the Atlas tier.

## Deploy to AWS + Atlas

```bash
cp deploy/terraform/terraform.tfvars.example deploy/terraform/terraform.tfvars
export TF_VAR_atlas_public_key=...  TF_VAR_atlas_private_key=...  TF_VAR_atlas_org_id=...
export TF_VAR_voyage_api_key=...
deploy/scripts/deploy.sh
```

Provisions EC2 (Docker + nginx) and a MongoDB Atlas M10 over VPC peering, in demo mode by
default. Full guide: [`deploy/README.md`](deploy/README.md).

## Tests

```bash
pnpm test        # vitest run, 40 test files
pnpm typecheck   # tsc --noEmit
```

The suite runs with no cluster, no API key, and no network. `pnpm typecheck` is a separate gate that
has to be run: `tsx` strips types without checking them, so a type error will not stop the server
from starting.

## Documentation

| | |
|---|---|
| [Getting started](docs/getting-started.md) | Stand it up and watch one investigation run |
| [Architecture](docs/architecture.md) | C4 diagrams, the pipeline sequence, where the time goes |
| [MongoDB capabilities](docs/mongodb-capabilities.md) | Each operator, its pipeline, and what it measured |
| [Decision records](docs/adr/README.md) | Ten decisions where the obvious choice was not the one taken |
| [API reference](docs/api-reference.md) | All 15 endpoints and every error case |
| [Data model](docs/data-model.md) | Collections, indexes, money, embeddings |
| [Configuration](docs/configuration.md) | Every environment variable |
| [Operations](docs/operations.md) | Scripts, the replay lifecycle, benchmarking, troubleshooting |
| [Developer guide](docs/developer-guide.md) | Layout, tests, extension points |
| [Contributing](CONTRIBUTING.md) | Opening a pull request |

Licensed under [Apache 2.0](LICENSE). All data in this repository is synthetic.
