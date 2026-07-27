import type { Db } from 'mongodb';
import { logger } from '../observability/logger';
import { waitForQueryable } from '../data/provision-transactions';
import { EMBED_DIM } from '../mastra/schemas/transactions';
import {
  POLICIES_COLLECTION, POLICY_VECTOR_INDEX, POLICY_SEARCH_INDEX, POLICY_SEED, type Policy,
} from './policies';

export type EmbedFn = (texts: string[]) => Promise<number[][]>;

/**
 * The policy vector index definition. `EMBED_DIM` rather than a literal 1024: policy vectors come
 * from the same embedder as transaction vectors, so a model change has to move both together or
 * `$vectorSearch` rejects the query on a dimension mismatch.
 *
 * Both filter paths are load-bearing — `reviewAction` filters on `is_current_version` to keep
 * superseded policy versions out of a live compliance check (the immutable-append model), and
 * `category` narrows the search. A filter path missing from the definition is an ERROR at query
 * time, not a silently ignored clause.
 */
function policyVectorIndexDefinition() {
  return {
    fields: [
      { type: 'vector', path: 'embedding', numDimensions: EMBED_DIM, similarity: 'cosine' },
      { type: 'filter', path: 'is_current_version' },
      { type: 'filter', path: 'category' },
    ],
  };
}

/** Compare a live Atlas definition to the one in code. Field ORDER is not significant to Atlas but
 *  is to JSON.stringify, so match by (type, path) rather than by position — otherwise a reordering
 *  in code would trigger a pointless rebuild on every deploy. */
function definitionMatches(live: any, wanted: ReturnType<typeof policyVectorIndexDefinition>): boolean {
  const liveFields: any[] = live?.fields ?? [];
  if (liveFields.length !== wanted.fields.length) return false;
  return wanted.fields.every(w => {
    const f = liveFields.find(l => l.type === w.type && l.path === w.path);
    if (!f) return false;
    // Only the vector field carries further attributes worth reconciling; a filter field is
    // fully described by its type and path.
    if (w.type !== 'vector') return true;
    return f.numDimensions === (w as any).numDimensions && f.similarity === (w as any).similarity;
  });
}

/**
 * Create the policy `$vectorSearch` (cosine, filtered on is_current_version + category) and
 * `$search` indexes directly on the `policies` collection, then wait until the vector index is
 * queryable.
 *
 * **The vector definition is reconciled, not merely created** — the same fix already applied to
 * `provisionTransactionVectorIndex`. This function used to skip creation whenever the index NAME
 * existed, which meant editing the definition above had no effect on any cluster already
 * provisioned: the change looked deployed while every governance query still ran against the old
 * definition. A `vectorSearch` definition can be updated in place (`updateSearchIndex` stages the
 * new index and swaps it atomically, keeping the old one queryable throughout), so reconciling here
 * costs no downtime. The `policies` collection holds 5 documents, so a rebuild is instant.
 *
 * The `$search` index is still create-only: Atlas has no update-in-place for a mapping change, so
 * changing it needs an explicit drop — see `provisionTransactionSearchIndex`'s `recreate` option.
 * It is left create-only deliberately rather than by omission, since `dynamic: true` over 5 short
 * policy documents has no cost worth a drop-and-rebuild path nothing calls.
 */
export async function provisionPolicyIndexes(db: Db, opts: { waitDelayMs?: number } = {}): Promise<void> {
  const col = db.collection(POLICIES_COLLECTION);
  await col.createIndex({ _id: 1 }).catch(() => { /* materialize namespace */ });

  // `any` because the driver types listSearchIndexes() as `{ name: string }[]` while Atlas returns
  // the full document — including `latestDefinition`, which is what says whether the live
  // definition matches the code's.
  const existing: any[] = await col.listSearchIndexes().toArray().catch(() => []);
  const current = existing.find((i: any) => i.name === POLICY_VECTOR_INDEX);
  const wanted = policyVectorIndexDefinition();
  let updated = false;
  if (!current) {
    await col.createSearchIndex({
      name: POLICY_VECTOR_INDEX, type: 'vectorSearch', definition: wanted,
    } as any);
    logger.info('policy vector index created', { index: POLICY_VECTOR_INDEX });
  } else if (!definitionMatches(current.latestDefinition, wanted)) {
    await (col as any).updateSearchIndex(POLICY_VECTOR_INDEX, wanted);
    updated = true;
    logger.info('policy vector index definition updated', { index: POLICY_VECTOR_INDEX });
  }

  if (!existing.some((i: any) => i.name === POLICY_SEARCH_INDEX)) {
    await col.createSearchIndex({ name: POLICY_SEARCH_INDEX, definition: { mappings: { dynamic: true } } } as any)
      .catch((err) => logger.warn('policy search index creation failed', { err: String(err) }));
  }
  // Partial-unique index: exactly one current version per policy_code (immutable-append model).
  await col.createIndex({ policy_code: 1 },
    { unique: true, partialFilterExpression: { is_current_version: true }, name: 'policy_code_current_unique' })
    .catch((err) => logger.warn('policy unique index skipped', { err: String(err) }));

  // On the update path also require status READY: Atlas keeps the OLD definition queryable while an
  // update builds, so `queryable` alone would return immediately and report the change as applied
  // while queries still hit the previous definition.
  if (await waitForQueryable(col, POLICY_VECTOR_INDEX, 30, opts.waitDelayMs ?? 2000, updated)) {
    logger.info('policy vector index ready');
    return;
  }
  logger.warn('policy vector index not queryable yet after wait');
}

/** Embed and upsert the seed policy set (by policy_code). Idempotent. Returns count. */
export async function seedPolicies(db: Db, embed: EmbedFn): Promise<number> {
  const col = db.collection<Policy>(POLICIES_COLLECTION);
  const vectors = await embed(POLICY_SEED.map(p => p.policy_text));
  let n = 0;
  for (let i = 0; i < POLICY_SEED.length; i++) {
    const doc = { ...POLICY_SEED[i], embedding: vectors[i] } as Policy;
    await col.replaceOne({ policy_code: doc.policy_code }, doc, { upsert: true });
    n++;
  }
  return n;
}
