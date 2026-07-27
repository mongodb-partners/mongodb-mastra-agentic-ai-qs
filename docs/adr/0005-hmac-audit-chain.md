# ADR 0005: HMAC hash chain with a key fingerprint on every record

Status: accepted

## Context

Every decision in Marshal needs an audit record, and the audit trail needs to be tamper-evident: if
someone edits an audit record after the fact, verification must say so. A plain append-only collection
does not give that. Someone with write access can change a record and nothing detects it.

## Decision

Each audit record is HMAC-chained to its predecessor.

```
current_hash = HMAC-SHA256(AUDIT_SECRET, previous_hash + canonicalJSON(event))
```

`canonicalize` sorts object keys recursively so the hash does not depend on key ordering, and the
timestamp is serialized as an ISO string before hashing. The first record chains to a genesis hash of
64 zeros.

Records carry only payload *shape*, never raw PII: field names touched, counts, disposition.

**What the chain does and does not cover.** The HMAC is computed over the audit event alone:
`event_type`, `entity_id`, `actor`, `payload_summary`, and `timestamp`. It does not cover the
`case_decisions` document, the transaction, or the case. Editing a stored decision's
`confidence_score` or `reasoning` leaves the chain verifying clean, because no byte of that document
feeds the hash. What verification detects is an edited, reordered, inserted, or removed *audit
record*. Because the append commits in the same transaction as the decision, a decision with no
audit record at all is prevented, so a deletion is visible as a broken link. Detecting edits to the
decision body itself would mean hashing the decision document into `payload_summary`, which is not
what the code does.

The append runs inside the same transaction as the decision write, with the tail read session-scoped,
so a decision and its audit record commit together or not at all.

Every record also stores `hmac_key_id`: a 12-hex-character fingerprint of the signing key, derived as
`HMAC(secret, 'marshal-audit-key-id/v1')` truncated. It is derived from the same secret that computes
the hash rather than passed in, so the two cannot disagree.

## Consequences

`GET /api/audit/verify` recomputes the whole chain and reports each broken link with a reason:
`chain_link_broken` when the previous-hash pointer does not match, and otherwise `key_mismatch` or
`hmac_mismatch`.

That last distinction is the reason `hmac_key_id` exists, and it is the part that took a wrong turn
first. The field was originally a version counter, `(prior ?? 1) + 1` per re-sign. A counter cannot
answer the only question the field is for, which is "which key signed this record?" Worse, it answers
it backwards: two boxes holding the *same* key report different values, because each re-signed a
different number of times, and two boxes holding *different* keys report the same value, because both
re-signed once. A fingerprint has the property a counter does not. Same key, same id, on every box and
in every process, forever.

The two failure reasons call for opposite responses. `key_mismatch` means point at the right secret or
re-sign. `hmac_mismatch` means the content changed under a key that still matches, which is real
tampering. Neither flips `ok`; both are failures. Only the remedy differs.

An absent `hmac_key_id` is deliberately not reported as a key mismatch. A record predating the field,
or one whose id was stripped, falls back to `hmac_mismatch`, because sending an operator to rotate a
key over genuine tampering is the worse error.

Truncating the fingerprint to 12 characters is safe because it is an equality label for a human reading
a record, not a security boundary. `verifyChain` ignores the field when recomputing and derives the
expected key from the configured secret, so forging a matching id buys nothing and requires the secret
anyway. Publishing the fingerprint in a record leaks nothing usable, for the same reason `current_hash`
can sit next to the event it signs.

**Concurrent appends can fork the chain, and this is not yet solved.** Each append reads the current
tail and inserts a new document. Two transactions that read the same tail insert two *different*
documents, and MongoDB's snapshot isolation raises a write conflict on contended writes to the same
document, not on independent inserts. So nothing forces one of them to abort: both can commit,
chaining to the same `previous_hash`. Verification then reports `chain_link_broken` at the second
one, because it walks a single ordered sequence.

The reason this has not bitten is that the app commits decisions one at a time: a run processes cases
sequentially, and the human-review path is serialized by an atomic claim. The fork needs genuinely
concurrent commits, which no current code path produces. It is a real limit, not a safe design, and
anyone adding parallel case commits has to close it first. A unique index on `previous_hash` would
force the conflict the current code assumes it already gets.

The chain is only as good as the secret. `AUDIT_SECRET` is required in production with the live agent,
and the dev fallback is never a valid production key. Losing the secret means the chain can no longer be
verified, and there is no recovery path other than re-signing, which is exactly the operation an
attacker would want. See [configuration.md](../configuration.md#secrets).

The most common "broken chain" in practice is not tampering. It is a deployment that restored a
recording and then set a fresh `AUDIT_SECRET`. That is why the export path normalizes the signing key,
and why the verify endpoint names the two cases differently.
