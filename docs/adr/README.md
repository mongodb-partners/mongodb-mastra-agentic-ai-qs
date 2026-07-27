# Architecture decision records

Ten decisions where the obvious choice was not the one taken. Each record states what the default would
have been, what was chosen instead, and what it cost. Numbers in these records were measured on this
codebase at the corpus size stated.

| # | Decision |
|---|---|
| [0001](0001-one-cluster-for-every-capability.md) | One Atlas cluster serves every capability |
| [0002](0002-rules-bracket-the-llm.md) | Deterministic rules bracket the LLM |
| [0003](0003-server-side-rank-fusion.md) | `$rankFusion` server-side instead of client-side RRF |
| [0004](0004-grounded-fail-closed-governance.md) | Governance is grounded in retrieved policy and fails closed |
| [0005](0005-hmac-audit-chain.md) | HMAC hash chain with a key fingerprint on every record |
| [0006](0006-evidence-bound-human-review.md) | Human review is bound by an evidence hash |
| [0007](0007-vector-storage-and-quantization.md) | Vectors as float32 `BinData`, quantization by corpus size |
| [0008](0008-decimal128-money.md) | `amount` is `Decimal128`, behind one module |
| [0009](0009-replay-isolation.md) | Demo mode replays immutable `replay_*` collections |
| [0010](0010-no-build-step.md) | No build step |

For how these fit together, see [../architecture.md](../architecture.md).
