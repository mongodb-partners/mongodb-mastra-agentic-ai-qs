import type { Db } from 'mongodb';
import { logger } from '../observability/logger';
import {
  POLICIES_COLLECTION, POLICY_VECTOR_INDEX, POLICY_SEARCH_INDEX, POLICY_SEED, type Policy,
} from './policies';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export type EmbedFn = (texts: string[]) => Promise<number[][]>;

/** Create the policy $vectorSearch (1024-dim cosine, filtered on is_current_version) + $search
 *  indexes directly on the `policies` collection, then wait until the vector index is queryable. */
export async function provisionPolicyIndexes(db: Db): Promise<void> {
  const col = db.collection(POLICIES_COLLECTION);
  await col.createIndex({ _id: 1 }).catch(() => {});
  const existing = await col.listSearchIndexes().toArray().catch(() => []);
  if (!existing.some((i: any) => i.name === POLICY_VECTOR_INDEX)) {
    await col.createSearchIndex({
      name: POLICY_VECTOR_INDEX, type: 'vectorSearch',
      definition: {
        fields: [
          { type: 'vector', path: 'embedding', numDimensions: 1024, similarity: 'cosine' },
          { type: 'filter', path: 'is_current_version' },
          { type: 'filter', path: 'category' },
        ],
      },
    } as any);
    logger.info('policy vector index created', { index: POLICY_VECTOR_INDEX });
  }
  if (!existing.some((i: any) => i.name === POLICY_SEARCH_INDEX)) {
    await col.createSearchIndex({ name: POLICY_SEARCH_INDEX, definition: { mappings: { dynamic: true } } } as any)
      .catch((err) => logger.warn('policy search index creation failed', { err: String(err) }));
  }
  // Partial-unique index: exactly one current version per policy_code (immutable-append model).
  await col.createIndex({ policy_code: 1 },
    { unique: true, partialFilterExpression: { is_current_version: true }, name: 'policy_code_current_unique' })
    .catch((err) => logger.warn('policy unique index skipped', { err: String(err) }));

  for (let i = 0; i < 30; i++) {
    const idx = (await col.listSearchIndexes().toArray().catch(() => []))
      .find((x: any) => x.name === POLICY_VECTOR_INDEX);
    if (idx && (idx as any).queryable) { logger.info('policy vector index ready'); return; }
    await sleep(2000);
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
