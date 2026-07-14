import type { Db } from 'mongodb';
import { logger } from '../observability/logger';
import {
  TRANSACTIONS_COLLECTION, TRANSACTIONS_VECTOR_INDEX, TRANSACTIONS_SEARCH_INDEX, EMBED_DIM,
} from '../mastra/schemas/transactions';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

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
 * Create the Atlas `$vectorSearch` index **directly on the operational `transactions`
 * collection** (1024-dim cosine on the `embedding` path). We use the driver's
 * `createSearchIndex` — NOT a Mastra vector adapter — so the index lives on the same documents
 * the agent reads and writes (the "same documents, one cluster" story). Idempotent; waits until
 * the index reports queryable. Best-effort logging on failure.
 */
export async function provisionTransactionVectorIndex(db: Db): Promise<void> {
  const col = db.collection(TRANSACTIONS_COLLECTION);
  await col.createIndex({ _id: 1 }).catch(() => { /* materialize namespace */ });
  const existing = await col.listSearchIndexes().toArray().catch(() => []);
  if (!existing.some((i: any) => i.name === TRANSACTIONS_VECTOR_INDEX)) {
    await col.createSearchIndex({
      name: TRANSACTIONS_VECTOR_INDEX,
      type: 'vectorSearch',
      definition: {
        fields: [
          { type: 'vector', path: 'embedding', numDimensions: EMBED_DIM, similarity: 'cosine' },
          { type: 'filter', path: 'status' },
        ],
      },
    } as any);
    logger.info('transactions vector index created', { index: TRANSACTIONS_VECTOR_INDEX });
  }
  // Wait until queryable (Atlas builds asynchronously).
  for (let i = 0; i < 30; i++) {
    const idx = (await col.listSearchIndexes().toArray().catch(() => []))
      .find((x: any) => x.name === TRANSACTIONS_VECTOR_INDEX);
    if (idx && (idx as any).queryable) { logger.info('transactions vector index ready', { index: TRANSACTIONS_VECTOR_INDEX }); return; }
    await sleep(2000);
  }
  logger.warn('transactions vector index not queryable yet after wait', { index: TRANSACTIONS_VECTOR_INDEX });
}

export async function provisionTransactionSearchIndex(db: Db): Promise<void> {
  const col = db.collection(TRANSACTIONS_COLLECTION);
  try {
    // createSearchIndex requires the namespace to exist; a no-op index materializes it.
    await col.createIndex({ _id: 1 }).catch(() => { /* namespace may already exist */ });
    const existing = await col.listSearchIndexes().toArray().catch(() => []);
    if (existing.some((i: any) => i.name === TRANSACTIONS_SEARCH_INDEX)) return;
    await col.createSearchIndex({
      name: TRANSACTIONS_SEARCH_INDEX,
      // Index the narrative + party names; dynamic mapping covers text + sender/recipient.name.
      definition: { mappings: { dynamic: true } },
    } as any);
    logger.info('transactions search index created', { index: TRANSACTIONS_SEARCH_INDEX });
  } catch (err) {
    logger.warn('transactions search index creation failed; hybrid search runs vector-only until it exists', {
      index: TRANSACTIONS_SEARCH_INDEX, err: String(err),
    });
  }
}
