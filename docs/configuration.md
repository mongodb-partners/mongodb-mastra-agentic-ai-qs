# Configuration

Every setting is an environment variable, parsed and validated once at startup by
[`src/config.ts`](../src/config.ts). An invalid value fails startup rather than degrading at runtime.

Local runs load `.env` via Node's built-in `process.loadEnvFile()`. The file is optional; a missing
`.env` is not an error, but a missing required variable is. Copy `.env.example` to start.

**A blank value is not an absent value.** `KEY=` in `.env` sets the variable to an empty string, and
the optional settings default with `??`, which only fires on `undefined`. So a variable left blank
rather than commented out reaches the app as `''`, not as its documented default. `.env.example` ships
`VOYAGE_BASE_URL=`, `AUDIT_SECRET=`, and `SESSION_SECRET=` blank, which means a copied file gives an
empty Voyage base URL instead of `https://ai.mongodb.com/v1`, and empty HMAC secrets instead of the dev
fallbacks. The required variables are caught (`VOYAGE_API_KEY` has a `min(1)`, so blank fails startup
loudly), and production with the live agent still refuses to start on an empty `AUDIT_SECRET` or
`SESSION_SECRET`. The quiet cases are the optional ones. Comment out the line, or delete it, when you
want the default.

## Required

| Variable | Type | Notes |
|---|---|---|
| `MONGODB_URI` | string | Must point at a replica set. The app uses change streams and multi-document transactions, neither of which works on a standalone |
| `VOYAGE_API_KEY` | string | Voyage AI key. An Atlas-scoped key authenticates against the MongoDB-hosted gateway |

## Application

| Variable | Type | Default | Notes |
|---|---|---|---|
| `APP_NAME` | string | `Marshal` | Returned by `/api/health` and used in log lines |
| `MONGODB_DB` | string | `marshal` | Database name. Note the name: the app reads `MONGODB_DB`, not `MONGODB_DATABASE` |
| `PORT` | integer | `8000` | Positive integer |
| `NODE_ENV` | string | unset | `production` enables the secret checks below |
| `DEMO_MODE` | flag | unset (off) | `1` or `true` enables replay mode |
| `SEED_SCALE_COUNT` | integer | `1200` | Synthetic decided-precedent corpus size. `0` disables it |

## Embeddings

| Variable | Type | Default | Notes |
|---|---|---|---|
| `VOYAGE_API_KEY` | string | required | See above |
| `VOYAGE_BASE_URL` | string | unset | Overrides the endpoint. Unset means `https://ai.mongodb.com/v1`. Blank is not unset: see above |

The embedding model itself is not configurable by environment variable. It is `EMBED_MODEL` in
[`src/mastra/embed.ts`](../src/mastra/embed.ts), currently `voyage-4`, because it is a property of
the stored corpus rather than of a deployment. Changing it requires re-embedding every stored vector
in the same commit; see [data-model.md](data-model.md#embeddings).

## LLM

| Variable | Type | Default | Notes |
|---|---|---|---|
| `LLM_PROVIDER` | enum | `anthropic` | `anthropic`, `openai`, or `bedrock` |
| `LLM_MODEL` | string | `claude-haiku-4-5` | Model id as the chosen provider names it |
| `LLM_BASE_URL` | string | unset | Gateway routing. For `anthropic` this must be the API root (a trailing `/messages` is stripped) |
| `LLM_GATEWAY_API_KEY` | string | unset | Sent as the `api-key` header, and as the API key, when routing `anthropic` through a gateway |
| `BEDROCK_REGION` | string | unset | Region for `bedrock`. Credentials come from the standard AWS provider chain |

Per-model output ceilings are matched exactly against the configured model id, so a Bedrock
deployment must use its fully-qualified id (`us.anthropic.claude-haiku-4-5-20251001-v1:0`) to get
8,192 output tokens. An unlisted id still works, it just gets the conservative 4,096 fallback, which
can truncate a long rationale mid-sentence. The list is `MAX_TOKENS` in
[`src/mastra/models.ts`](../src/mastra/models.ts).

## Secrets

| Variable | Type | Default | Notes |
|---|---|---|---|
| `AUDIT_SECRET` | string | dev fallback | HMAC secret for the audit chain |
| `SESSION_SECRET` | string | dev fallback | HMAC secret for session tokens |

The two are deliberately separate so a leak of one cannot forge the other.

In production with the live agent (`NODE_ENV=production` and `DEMO_MODE` off), both must be set or
startup throws, and blank counts as unset for that check. Demo and non-production runs fall back to dev
values when the variable is absent: `AUDIT_SECRET` to `marshal-dev-audit-secret` and `SESSION_SECRET` to
`marshal-dev-session-secret`. Neither is ever a valid production key. A blank line in `.env` gets an
empty secret rather than the fallback, which still signs and still verifies, so it is consistent rather
than broken; it just is not the key the recording was signed with.

The audit dev fallback is exported as `DEV_AUDIT_SECRET` because the committed replay chain is signed
with it. Baking runs locally, where `AUDIT_SECRET` is usually unset, so `pnpm restore:replay` needs it
as the old key when re-signing the chain for a deployment that sets a real one.

There is a related trap worth stating plainly. A demo deployment that sets a fresh `AUDIT_SECRET`
*after* restoring the recording will show a broken audit chain, because the records were signed with
a different key. That is a key mismatch, not tampering, and `/api/audit/verify` reports it as
`key_mismatch` specifically so the two can be told apart. Restore after the secret is in place, or
leave `AUDIT_SECRET` unset in demo mode. The Terraform deployment does the latter; see
[`deploy/README.md`](../deploy/README.md).

## UI

| Variable | Type | Default | Notes |
|---|---|---|---|
| `MARSHAL_UI` | enum | `''` | `classic`, `auto`, or `''`. Fleet-wide layout default |
| `MARSHAL_DENSITY` | enum | `''` | `full`, `lean`, `minimal`, `auto`, or `''`. Default on-screen copy density |

`auto` and `''` are equivalent: both normalize to `''`, meaning the responsive layout picks a tier
from the viewport. `auto` is accepted on both variables because it is the word an operator reaches
for to mean "let the viewport decide", and rejecting it on one while accepting it on the other would
fail a deployment at startup over a spelling.

`classic` pins the fixed three-column stage layout at every viewport width for every visitor.

Both have per-visitor query-parameter overrides that need no restart: `?ui=classic` and
`?density=lean`. Those are the mid-demo escape hatches; the environment variables are the default.

Both are exposed on `GET /api/mode` as `uiMode` and `uiDensity`.

## Not a setting: RRF_K

There is deliberately no reciprocal-rank-fusion constant. `$rankFusion` does not expose it; MongoDB
fixes it server-side. The variable used to exist, was loaded and validated, and was then read by
nothing, which is worse than having no knob at all: an operator tunes it, measures no change, and
stops trusting the rest of the configuration.

Fusion weighting is controlled by the per-branch limits in `buildRankFusionPipeline`
([`src/retrieval/pipelines.ts`](../src/retrieval/pipelines.ts)).

## Provisioning-only

These are read by scripts, not by `loadConfig`.

| Variable | Read by | Notes |
|---|---|---|
| `RECREATE_SEARCH_INDEX` | `pnpm provision` | `1` drops and rebuilds `transactions_search_index`. Required after a mapping change, since Atlas has no update-in-place for one. The collection has no lexical index while it rebuilds, so this is off by default |
| `BENCH_MONGODB_URI` | `pnpm bench:*` | Separate cluster for the benchmark corpus. Required by those scripts |
| `ALLOW_SHRINK` | `pnpm sync:corpus` | `1` permits deleting more than 1,000 synthetic transactions. Without it a large shrink throws, because that is the shape of a re-provision against a big corpus with a small `SEED_SCALE_COUNT` |

## Deployment

The Terraform deployment supplies the same variables as Terraform inputs and stores the secret-bearing
ones as SSM SecureString parameters. Variable names, defaults, and the demo-mode `AUDIT_SECRET`
behaviour are documented in [`deploy/README.md`](../deploy/README.md).
