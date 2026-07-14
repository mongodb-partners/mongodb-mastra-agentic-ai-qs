# Marshal: Fraud Investigation Console (MongoDB + Mastra)

An agentic fraud/claims investigation console built on **MongoDB Atlas + Mastra**. A Mastra
agent investigates each flagged transaction, and every capability runs on a single Atlas
cluster: `$vectorSearch`, `$search`, `$rankFusion` hybrid retrieval, `$graphLookup` fund-tracing,
policy governance, durable human-in-the-loop workflow state, and a tamper-evident audit chain.

## Quick start

```bash
pnpm install
cp .env.example .env    # set MONGODB_URI and VOYAGE_API_KEY
pnpm provision          # create indexes, seed cases, and the synthetic precedent corpus
pnpm dev                # API on http://localhost:8000
curl localhost:8000/api/health
```

`MONGODB_URI` must point at a replica set (the app uses change streams). See `.env.example`
for all options.

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
pnpm test        # vitest run
pnpm typecheck   # tsc --noEmit
```
