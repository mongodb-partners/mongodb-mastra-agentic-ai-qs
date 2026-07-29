import { MongoDBVector } from '@mastra/mongodb';
import type { Config } from '../config';
import { logger } from '../observability/logger';
import {
  TRANSACTIONS_COLLECTION, TRANSACTIONS_VECTOR_INDEX, EMBED_DIM,
} from '../mastra/schemas/transactions';
import { POLICIES_COLLECTION, POLICY_VECTOR_INDEX } from '../governance/policies';

/**
 * Stable LOGICAL index keys for `@mastra/mongodb`'s `MongoDBVector` registry.
 *
 * These are the `indexName` values written to the `__mastra_vector_indexes__` registry at provision
 * time and passed back at query time, so `resolveIndexTarget` can map them to the right BYO
 * collection and Atlas index names. They are deliberately NOT the physical names: the collection is
 * `transactions` / `policies` and the Atlas indexes are `transactions_vector_index` /
 * `policy_vector_index`, all of which live in the schema modules and are owned by the app's own
 * provisioning. Keeping the logical key separate is what makes the mapping explicit rather than a
 * coincidence of naming.
 *
 * A logical key that happens to equal its collection name is fine and expected for BYO — the library
 * records `isByo` at createIndex time precisely because it cannot be re-derived from the names.
 */
export const TRANSACTIONS_INDEX = 'transactions';
export const POLICIES_INDEX = 'policies';

/**
 * Construct a connected `MongoDBVector` over the app's Atlas cluster.
 *
 * EXPENSIVE — construct ONE per process and share it, never one per request. The library bundles its
 * own driver (mongodb v7) and this owns a full `MongoClient` with its own connection pool, entirely
 * separate from the app's v6 client. A per-request store would open a pool per case and exhaust the
 * cluster's connection limit long before it exhausted anything else.
 *
 * The two drivers coexist on the same cluster on purpose. The app's v6 `Db` keeps serving every
 * write (seeding, audit records, case analysis) and the `$graphLookup` fund trace, which has no
 * library equivalent; this store serves the three retrieval reads. Nothing needs the two to agree on
 * a driver version because they never share a handle — only the cluster.
 *
 * `id` is the store's own instance identifier, not an index name; callers pass something traceable
 * (e.g. 'marshal-retrieval') so log lines can be attributed.
 */
export async function createVectorStore(cfg: Config, id: string): Promise<MongoDBVector> {
  const vector = new MongoDBVector({ id, uri: cfg.mongoUri, dbName: cfg.mongoDb });
  await vector.connect();
  return vector;
}

/** What one BYO registration needs: a logical key mapped onto an existing collection + Atlas index. */
interface ByoRegistration {
  indexName: string;
  collectionName: string;
  searchIndexName: string;
}

export const BYO_REGISTRATIONS: readonly ByoRegistration[] = [
  {
    indexName: TRANSACTIONS_INDEX,
    collectionName: TRANSACTIONS_COLLECTION,
    searchIndexName: TRANSACTIONS_VECTOR_INDEX,
  },
  {
    indexName: POLICIES_INDEX,
    collectionName: POLICIES_COLLECTION,
    searchIndexName: POLICY_VECTOR_INDEX,
  },
] as const;

/**
 * Register the app's two operational collections with the store as READ-ONLY bring-your-own indexes.
 *
 * MUST RUN AFTER the app's own provisioning, never before, and never instead of it. `createIndex`
 * throws if a BYO collection does not exist, and it must find the Atlas index already present so
 * `createSearchIndexIgnoringExisting` no-ops — that no-op is the whole point. What the app's
 * provisioning declares that the library cannot is:
 *
 *   - `quantization: 'binary'` on the transactions vector index. `createIndex` has no parameter for
 *     it, and at 1M documents that setting is the difference between p50 34 ms and p50 2960 ms. If
 *     this call ever created the index instead of finding it, retrieval would still work and would
 *     be ~85x slower, which is the worst possible failure shape.
 *   - the `{type:'filter', path:'status'}` field that the precedent filter pushes down into, and
 *     `is_current_version` / `category` on policies.
 *
 * Deliberately NOT passed:
 *   - `filterFields`, because `buildDeclaredMetadataPaths` prefixes every entry with `metadata.` —
 *     paths these documents do not have. It is also unnecessary: `getDeclaredFilterPaths` hydrates
 *     from the LIVE index definition, so the app's own `status` declaration is what enables
 *     pushdown. Passing it would only add bogus paths to a definition this call must not change.
 *   - `allowWrites`, so both indexes stay read-only. This is the property worth demonstrating, and
 *     it is also true: every write in this app goes through the v6 driver (seeding, audit records,
 *     case analysis). A store that cannot mutate the corpus cannot corrupt a hash-sealed audit
 *     chain, and `assertWritable` makes that structural rather than a convention.
 *
 * Best-effort by design. A failure here costs the library read paths, not the app: the registry is
 * durable, so a later run can register successfully, and nothing about the collections themselves
 * has changed. Throwing would fail a provision run that has already done all its real work.
 */
export async function registerByoIndexes(vector: MongoDBVector): Promise<string[]> {
  const registered: string[] = [];
  for (const r of BYO_REGISTRATIONS) {
    try {
      await vector.createIndex({
        indexName: r.indexName,
        dimension: EMBED_DIM,
        metric: 'cosine',
        collectionName: r.collectionName,
        searchIndexName: r.searchIndexName,
      });
      registered.push(r.indexName);
      logger.info('registered read-only BYO vector index', {
        index: r.indexName, collection: r.collectionName, atlasIndex: r.searchIndexName,
      });
    } catch (err) {
      logger.warn('BYO vector index registration failed; library read paths unavailable for it', {
        index: r.indexName, collection: r.collectionName, err: String(err),
      });
    }
  }
  return registered;
}
