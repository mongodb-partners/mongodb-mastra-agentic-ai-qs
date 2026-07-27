# Getting started

This walks through standing Marshal up on your own Atlas cluster and watching one investigation run
end to end. Expect about 20 minutes, most of it waiting on the seed.

By the end you will have a seeded cluster, a running console, and an audit chain you have deliberately
broken and repaired.

## Prerequisites

| What | Why |
|---|---|
| Node.js 22 or later | The server uses `process.loadEnvFile()` |
| pnpm | Lockfile is pnpm's |
| A MongoDB Atlas cluster on 8.0 or later | `$rankFusion` needs 8.0. Any tier works; M0 is enough to start |
| A Voyage AI API key | Embeddings. An Atlas-scoped key works against the MongoDB-hosted gateway |
| An LLM API key | Anthropic, OpenAI, or AWS Bedrock credentials |

The cluster must be a replica set. Every Atlas tier is, so this only matters if you point at a local
single-node `mongod`.

Add your current IP to the Atlas project's access list before you start. A connection that hangs and
then fails with `ENETUNREACH` is almost always an IP that is not on the list.

## 1. Install and configure

```bash
pnpm install
cp .env.example .env
```

Open `.env` and set three things:

```bash
MONGODB_URI=mongodb+srv://user:password@cluster.mongodb.net/
VOYAGE_API_KEY=your-voyage-key
ANTHROPIC_API_KEY=your-anthropic-key
```

Everything else has a working default. `MONGODB_DB` defaults to `marshal`, `PORT` to 8000, and the
model to `claude-haiku-4-5`. The full list is in [configuration.md](configuration.md).

## 2. Provision the cluster

```bash
pnpm provision
```

This is the one command that creates state. It asserts the server supports `$rankFusion`, creates the
vector and lexical search indexes and the standard indexes, seeds 15 curated transactions across six
risk lanes, generates a synthetic precedent corpus of `SEED_SCALE_COUNT` documents (1,200 by default),
seeds 5 regulatory policies, and runs a search self-check.

Watch for these lines:

```
seeded transactions        { written: 15 }
seeded synthetic scale corpus  { … }
decided precedents         { … }
seeded policies            { policies: 5 }
provision-and-seed complete
```

Embedding is the slow part. Every transaction and policy is embedded through the Voyage gateway in
batches of 96.

The script is safe to re-run. Seeding is incremental: existing `txn-syn-` ids are skipped and only the
missing ones are inserted, in chunks, so an interrupted run resumes from where it stopped.

## 3. Start the server

```bash
pnpm dev
```

Nothing compiles. `tsx` runs the TypeScript sources directly, so this is the same command used in the
container. Check it is up:

```bash
curl localhost:8000/api/health
```

You should get `{"status":"ok","app":"Marshal"}`. That is a liveness check only; it does not touch the
cluster. Open <http://localhost:8000> for the console.

## 4. Run an investigation

The console has a run control, or you can drive it from the API. The API needs a token first:

```bash
TOKEN=$(curl -s -XPOST localhost:8000/api/token | sed 's/.*"token":"\([^"]*\)".*/\1/')
curl -XPOST localhost:8000/api/investigate/run -H "Authorization: Bearer $TOKEN"
```

Every pending case is investigated. One case is roughly 10 seconds, and most of that is the model:
`$rankFusion` retrieval measures a p50 of 34.2 ms against provider calls that run for seconds. The
`stage_share` field on `/api/stats` reports that direction but is not a valid per-stage split, for the
reason given under [known limits](architecture.md#known-limits).

Watch the console while it runs. The feed is not polling. It is a projection of a MongoDB change stream
over eight collections, pushed to the browser as server-sent events.

Each case moves through a fixed sequence: deterministic triage, hybrid precedent retrieval, agent
reasoning with five tools, fund tracing, policy governance, then deterministic reconciliation. Sanctions
cases short-circuit at triage and never reach the model. See
[architecture.md](architecture.md#the-investigation-pipeline) for the full sequence.

Some cases will land in the review queue rather than deciding. That is the design: a structuring amount,
a high-value approve, a detected ring, or low confidence all escalate.

## 5. Resolve a held case

Fetch the queue and resolve one:

```bash
curl -s localhost:8000/api/reviews | head -c 400
```

Each review carries an `evidence_hash`, the digest of the evidence the reviewer was shown. Resolve one:

```bash
curl -XPOST localhost:8000/api/reviews/<transaction_id>/resolve \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"decision":"approve"}'
```

The body carries the decision and nothing else. The server re-derives the evidence snapshot from
*current* transaction and analysis state, hashes it, and compares against the hash stored at suspend
time. A match commits the decision inside one transaction. A mismatch returns 409 `rejected_stale` and
commits nothing, because the evidence moved since the reviewer saw it. See
[ADR 0006](adr/0006-evidence-bound-human-review.md).

To see the refusal, edit the transaction's amount in Atlas and try again.

## 6. Break the audit chain on purpose

Every decision appends an HMAC-chained audit record. Verify it:

```bash
curl -s localhost:8000/api/audit/verify
```

Now tamper with one record and verify again:

```bash
pnpm beat:tamper
curl -s localhost:8000/api/audit/verify
```

`ok` is now false and the broken link is reported as `hmac_mismatch`. The console raises the alarm at
the same moment, through the change stream. Put it back:

```bash
pnpm beat:restore
```

There is a third demo beat, `pnpm beat:policy`, which touches a policy document and makes every
connected console show a live policy update. All three are real database writes; nothing is staged in
the browser.

## 7. Try demo mode

Demo mode replays a committed recording with no LLM calls at all. On a cluster that has been
provisioned:

```bash
pnpm restore:replay
DEMO_MODE=1 pnpm dev
```

The recording lives in immutable `replay_*` collections. Live runs and resets never touch them, so the
two modes coexist on one cluster. `restore:replay` also re-signs the audit chain under your
`AUDIT_SECRET`, which is why the chain verifies rather than showing as broken.

If you set a fresh `AUDIT_SECRET` *after* restoring, the chain will read as broken. That is a
`key_mismatch`, not tampering, and the verify endpoint names it separately for exactly that reason.

## Where to go next

- [architecture.md](architecture.md) for the C4 diagrams and the pipeline sequence
- [mongodb-capabilities.md](mongodb-capabilities.md) for each Atlas capability, its pipeline, and what
  it measured
- [operations.md](operations.md) for every script and the replay lifecycle
- [api-reference.md](api-reference.md) for all 15 endpoints
- [`deploy/README.md`](../deploy/README.md) to put it on AWS with Terraform
