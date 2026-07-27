import type { Db } from 'mongodb';
import { logger } from '../observability/logger';
import {
  TRANSACTIONS_COLLECTION, TRANSACTIONS_VECTOR_INDEX, TRANSACTIONS_SEARCH_INDEX, EMBED_DIM,
} from '../mastra/schemas/transactions';
import { estimatedCount } from './estimated-count';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Poll until an Atlas search index reports `queryable`. Atlas builds asynchronously, so a
 *  freshly created index answers queries with zero hits rather than an error — which reads as
 *  "empty cluster" downstream. Returns false on timeout; the caller decides how loud to be.
 *
 *  `requireReady` additionally waits for `status: 'READY'`, which matters ONLY on the in-place
 *  update path: during an update Atlas keeps the previous definition queryable, so `queryable`
 *  is already true and this would otherwise return immediately over a still-building index —
 *  reporting a definition change as applied while queries still hit the old encoding. Tolerant of
 *  a missing `status` field so a deployment can't hang on a shape this driver doesn't return. */
export async function waitForQueryable(
  col: any, name: string, attempts = 30, delayMs = 2000, requireReady = false,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const idx = (await col.listSearchIndexes().toArray().catch(() => []))
      .find((x: any) => x.name === name);
    const ready = !requireReady || idx?.status === undefined || idx.status === 'READY';
    if (idx && idx.queryable && ready) return true;
    await sleep(delayMs);
  }
  return false;
}

export function parseMajorMinor(version: string): [number, number] {
  const [maj, min] = version.split('.');
  return [Number(maj) || 0, Number(min) || 0];
}
export function supportsRankFusion(version: string): boolean {
  const [maj, min] = parseMajorMinor(version);
  return maj > 8 || (maj === 8 && min >= 0);
}

export async function assertRankFusionSupported(db: Db): Promise<void> {
  const info = (await db.admin().buildInfo()) as { version: string };
  if (!supportsRankFusion(info.version)) {
    throw new Error(
      `MongoDB ${info.version} predates $rankFusion (needs 8.0+). Use an Atlas cluster (any tier) or self-hosted 8.0+.`,
    );
  }
  logger.info('server supports $rankFusion', { version: info.version });
}

/**
 * Corpus size at or above which the vector index is built with `quantization: 'binary'`.
 *
 * Quantization is not a free win — its verdict is a function of whether the full-fidelity index
 * fits in RAM, so it does not travel across corpus sizes, and picking one setting for all scales is
 * wrong at one end or the other. Both ends were measured on an 8 GB cluster tier:
 *
 * - At **1M** docs, 1M x 1024 x 4 B is ~4 GB of float32 vectors beside a ~4.3 GB collection, so
 *   the index cannot stay resident and novel queries page in HNSW nodes: `$vectorSearch` alone
 *   measured p50 **2960 ms**. Binary is 1 bit/dim (128 B/vector, a 32x cut, ~128 MB resident) for
 *   the graph walk and then rescores the shortlist against the full-fidelity vectors, so at
 *   cand 400 it measured **recall 0.9830 @ p50 34.4 ms** — better recall AND ~2x faster than
 *   float32's 0.9700 @ 69.7 ms, with a flat tail (p99/p50 = 1.15 vs float32 blowing out to 3.7 s).
 * - At **12k** docs the float32 index is ~49 MB, resident trivially, and recall is **1.0000 at
 *   every** candidate level. Binary can only match that, and *below* cand 400 it loses recall
 *   (-2.50 pp at cand 50, -0.50 pp at 100) for a ~2.5 ms p50 win that is invisible next to an
 *   LLM-bound investigation. Shipping it at 12k would be a straight recall regression.
 *
 * The threshold sits well above the default seeded scale (~12k) and well below 1M, so a typical
 * deployment never lands near the boundary. `binary` also implies a candidate floor — see
 * `VECTOR_CANDIDATE_FLOOR` in `src/retrieval/pipelines.ts`.
 */
export const BINARY_QUANTIZATION_MIN_DOCS = 100_000;

/** Choose the quantization for a corpus of `docCount` documents. See BINARY_QUANTIZATION_MIN_DOCS. */
export function quantizationForCorpus(docCount: number): 'none' | 'binary' {
  return docCount >= BINARY_QUANTIZATION_MIN_DOCS ? 'binary' : 'none';
}

function vectorIndexDefinition(quantization: 'none' | 'binary') {
  return {
    fields: [
      {
        type: 'vector', path: 'embedding', numDimensions: EMBED_DIM, similarity: 'cosine',
        quantization,
      },
      { type: 'filter', path: 'status' },
    ],
  };
}

/**
 * Create the Atlas `$vectorSearch` index **directly on the operational `transactions`
 * collection** (1024-dim cosine on the `embedding` path). We use the driver's
 * `createSearchIndex` — NOT a Mastra vector adapter — so the index lives on the same documents
 * the agent reads and writes (the "same documents, one cluster" story). Idempotent; waits until
 * the index reports queryable. Best-effort logging on failure.
 *
 * **The definition is reconciled, not just created.** This function used to return early when the
 * index name already existed, which meant changing the definition in code had no effect on any
 * cluster already provisioned — silently, so a fix looked deployed and wasn't. Unlike the BM25
 * mapping (see `provisionTransactionSearchIndex`, which needs an explicit drop), a vectorSearch
 * definition CAN be updated in place: `updateSearchIndex` stages the new index and swaps it in
 * atomically, keeping the old one queryable throughout. Verified against a running 1M-document
 * cluster — a quantization change reported `status: BUILDING, queryable: true` and kept serving the
 * old definition until the swap, so reconciling here needs no downtime window.
 */
export async function provisionTransactionVectorIndex(
  db: Db, opts: { waitDelayMs?: number } = {},
): Promise<void> {
  const col = db.collection(TRANSACTIONS_COLLECTION);
  await col.createIndex({ _id: 1 }).catch(() => { /* materialize namespace */ });

  // Quantization depends on how many documents the index will hold, so count before defining it.
  // estimatedDocumentCount is metadata-only (no scan) — the exact number doesn't matter here,
  // only which side of a 100k threshold it falls on.
  const docCount = await estimatedCount(col);
  const quantization = quantizationForCorpus(docCount);

  // `any` because the driver types listSearchIndexes() as `{ name: string }[]`, while Atlas
  // returns the full document — including `latestDefinition`, which is what says whether the live
  // definition matches the code's.
  const existing: any[] = await col.listSearchIndexes().toArray().catch(() => []);
  const current = existing.find((i: any) => i.name === TRANSACTIONS_VECTOR_INDEX);
  let updated = false;
  if (!current) {
    await col.createSearchIndex({
      name: TRANSACTIONS_VECTOR_INDEX,
      type: 'vectorSearch',
      definition: vectorIndexDefinition(quantization),
    } as any);
    logger.info('transactions vector index created', {
      index: TRANSACTIONS_VECTOR_INDEX, quantization, docCount,
    });
  } else {
    // Atlas omits the key entirely when unquantized, so absent === 'none'.
    const live = (current.latestDefinition?.fields ?? [])
      .find((f: any) => f.type === 'vector')?.quantization ?? 'none';
    if (live !== quantization) {
      await (col as any).updateSearchIndex(
        TRANSACTIONS_VECTOR_INDEX, vectorIndexDefinition(quantization),
      );
      updated = true;
      logger.info('transactions vector index definition updated', {
        index: TRANSACTIONS_VECTOR_INDEX, from: live, to: quantization, docCount,
      });
    }
  }
  // Wait until queryable (Atlas builds asynchronously). On the update path also wait for READY —
  // see waitForQueryable. A 1M rebuild takes minutes and saturates an M30's CPU while it runs, so
  // the ceiling is generous; timing out here is a warning, not a failure, because the old
  // definition is still serving.
  const attempts = updated ? 120 : 30;
  if (await waitForQueryable(col, TRANSACTIONS_VECTOR_INDEX, attempts, opts.waitDelayMs ?? 2000, updated)) {
    logger.info('transactions vector index ready', { index: TRANSACTIONS_VECTOR_INDEX, quantization });
    return;
  }
  logger.warn('transactions vector index not queryable yet after wait', { index: TRANSACTIONS_VECTOR_INDEX });
}

/** The two fields `buildGraphPipeline` traverses: the anchor `$match` and `connectToField` both
 *  use `sender.account_number`, and `startWith`/`connectFromField` use `recipient.account_number`. */
export const GRAPH_INDEX_FIELDS = ['sender.account_number', 'recipient.account_number'] as const;

/**
 * B-tree indexes for the `$graphLookup` traversal. Without an index on `connectToField`, every
 * depth level is a full collection scan — at 1M documents and maxDepth 3 that is four scans per
 * ring trace. Neither field was indexed on the live cluster (only `_id_`, `transaction_id_1`,
 * `created_at_-1`, `status_1`).
 *
 * Unlike every other `createIndex` in this repo, these do NOT swallow errors. A missing graph
 * index does not fail a query — it just makes it scan — so `.catch(() => {})` here would turn a
 * failed build into an unexplained slow benchmark with no error anywhere. Create, then verify
 * the names are actually present, then throw naming what is missing.
 *
 * Single-field on purpose: a covering compound index was measured at 46 ms vs 48 ms (noise),
 * because `$graphLookup` fetches full documents during traversal and never uses a covered scan.
 */
export async function provisionGraphIndexes(db: Db): Promise<string[]> {
  const col = db.collection(TRANSACTIONS_COLLECTION);
  const wanted = GRAPH_INDEX_FIELDS.map(f => `${f}_1`);
  for (const field of GRAPH_INDEX_FIELDS) await col.createIndex({ [field]: 1 });

  const present = new Set((await col.indexes()).map((i: any) => i.name));
  const missing = wanted.filter(n => !present.has(n));
  if (missing.length) {
    throw new Error(
      `graph indexes missing after provisioning: ${missing.join(', ')} — ` +
      '$graphLookup would run a collection scan per depth level',
    );
  }
  logger.info('graph indexes ready', { indexes: wanted });
  return wanted;
}

/**
 * Create the Atlas `$search` (BM25) index on `transactions`.
 *
 * The mapping is STATIC. It used to be `dynamic: true`, which indexes every field in the
 * document — including the 1024-float `embedding`, i.e. a large Lucene index over numbers
 * nothing ever queries lexically. The only BM25 targets are `text` and the two party names,
 * which is exactly what `buildLexicalPipeline` and the `$rankFusion` lexical branch search.
 *
 * `opts.recreate` exists because this function returns early when the index already exists,
 * so **changing the definition in code has no effect on a cluster that already has one** —
 * and Atlas has no update-in-place for a mapping change. Without an explicit drop-and-rebuild
 * the static mapping would never land on either live cluster. Pass `{ recreate: true }` when
 * the definition above has changed since the cluster was provisioned.
 */
export async function provisionTransactionSearchIndex(
  db: Db, opts: { recreate?: boolean; waitDelayMs?: number } = {},
): Promise<void> {
  const col = db.collection(TRANSACTIONS_COLLECTION);
  try {
    // createSearchIndex requires the namespace to exist; a no-op index materializes it.
    await col.createIndex({ _id: 1 }).catch(() => { /* namespace may already exist */ });
    const existing = await col.listSearchIndexes().toArray().catch(() => []);
    const already = existing.some((i: any) => i.name === TRANSACTIONS_SEARCH_INDEX);
    if (already && !opts.recreate) return;
    if (already) {
      await (col as any).dropSearchIndex(TRANSACTIONS_SEARCH_INDEX);
      logger.info('dropped search index for recreate', { index: TRANSACTIONS_SEARCH_INDEX });
    }
    await col.createSearchIndex({
      name: TRANSACTIONS_SEARCH_INDEX,
      definition: {
        mappings: {
          dynamic: false,
          fields: {
            text: { type: 'string' },
            sender: { type: 'document', fields: { name: { type: 'string' } } },
            recipient: { type: 'document', fields: { name: { type: 'string' } } },
          },
        },
      },
    } as any);
    logger.info('transactions search index created', { index: TRANSACTIONS_SEARCH_INDEX, dynamic: false });
    if (already) {
      // Only wait on the recreate path. A drop-and-rebuild leaves the collection with NO lexical
      // index until the build finishes, and runSearchSelfCheck downstream only retries for ~16s —
      // on a large corpus that fails the deploy on a healthy cluster. Wait here instead.
      const ready = await waitForQueryable(col, TRANSACTIONS_SEARCH_INDEX, 30, opts.waitDelayMs ?? 2000);
      logger[ready ? 'info' : 'warn'](
        ready ? 'transactions search index queryable after recreate' : 'transactions search index still building after recreate; lexical retrieval returns no hits until it finishes',
        { index: TRANSACTIONS_SEARCH_INDEX },
      );
    }
  } catch (err) {
    logger.warn('transactions search index creation failed; hybrid search runs vector-only until it exists', {
      index: TRANSACTIONS_SEARCH_INDEX, err: String(err),
    });
  }
}
