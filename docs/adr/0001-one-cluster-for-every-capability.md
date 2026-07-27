# ADR 0001: One Atlas cluster serves every capability

Status: accepted

## Context

Marshal needs vector similarity search, lexical search, hybrid fusion of the two, graph traversal
over an account network, multi-document ACID commits, and a live push feed to the browser.

The default architecture for that list is three or four systems: a relational or document store for
the operational data, a dedicated vector database, a search cluster, and something for the live feed.
Each is defensible on its own. Together they mean a sync pipeline between the operational documents
and their vectors, two consistency models, two failure modes, two backup stories, and a class of bug
where a document and its embedding disagree about what version of the world they belong to.

## Decision

Everything runs on one MongoDB Atlas cluster. The vector index is built directly on the operational
`transactions` collection, on the `embedding` field of the same documents the pipeline reads and
writes.

| Need | Implementation |
|---|---|
| Vector similarity | `$vectorSearch` on `transactions.embedding` |
| Lexical | `$search` on `transactions` |
| Hybrid | `$rankFusion` fusing the two server-side |
| Graph | `$graphLookup` on `transactions` |
| Policy retrieval | `$vectorSearch` on `policies` |
| Durable decisions | Multi-document transactions |
| Live feed | Change streams |

No Mastra vector adapter, no sync job, no second connection string.

## Consequences

There is no window in which a document and its vector disagree, because they are the same document. A
retrieval hit is a full document, so nothing needs a second fetch to resolve an id into content.

Precedent retrieval can filter to decided cases inside `$vectorSearch` via a `filter` path on
`status`, rather than over-fetching and filtering in application code. A separate vector store would
either not know the status or know a stale copy of it.

`$rankFusion` requires MongoDB 8.0 or later. Provisioning asserts this explicitly with a clear error
rather than letting the pipeline fail at query time.

`MONGODB_URI` must point at a replica set, because transactions and change streams both require one.
Every Atlas tier is a replica set, so this only constrains local single-node setups.

The cluster is a single point of failure by construction. That is the accepted trade: one system to
size, secure, monitor, and back up, in exchange for having no fallback if it is down. For a
demonstration application that is clearly correct. For a production deployment it is a deliberate
choice about where to spend operational complexity, not a default to inherit unexamined.

Sizing has to account for every workload at once, and the interaction is measurable rather than
theoretical: adding a second 1M-document vector index to one M30 moved an untouched index's p50 from
21.0 to 179.6 ms. Vector index memory is the term that dominates, which is why quantization is chosen
by corpus size (see [ADR 0007](0007-vector-storage-and-quantization.md)).
