import type { Db } from 'mongodb';
import { logger } from '../observability/logger';
import type { EmbedFn } from './seed-transactions';
import {
  TRANSACTIONS_COLLECTION, TRANSACTIONS_VECTOR_INDEX, TRANSACTIONS_SEARCH_INDEX,
} from '../mastra/schemas/transactions';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function runSearchSelfCheck(
  db: Db, embed: EmbedFn, opts: { retries?: number; delayMs?: number } = {},
): Promise<void> {
  const retries = opts.retries ?? 8;
  const delayMs = opts.delayMs ?? 2000;
  const col = db.collection(TRANSACTIONS_COLLECTION);
  const [qvec] = await embed(['cash deposit just under the reporting threshold']);

  // Both probes retry: on a freshly (re)built index Atlas vector AND search are eventually
  // consistent, so newly-seeded docs may not be queryable for a few seconds. Poll until both
  // return hits, or fail loudly — this fence catches the "empty results on a fresh cluster"
  // demo-killer.
  let vLast = 0;
  let sLast = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const vHits = await col.aggregate([
      { $vectorSearch: { index: TRANSACTIONS_VECTOR_INDEX, path: 'embedding', queryVector: qvec, numCandidates: 50, limit: 3 } },
      { $project: { _id: 0, transaction_id: 1 } },
    ]).toArray().catch(() => []);
    const sHits = await col.aggregate([
      { $search: { index: TRANSACTIONS_SEARCH_INDEX, text: { query: 'cash deposit threshold', path: ['text'] } } },
      { $limit: 3 }, { $project: { _id: 0, transaction_id: 1 } },
    ]).toArray().catch(() => []);
    vLast = vHits.length;
    sLast = sHits.length;
    if (vLast > 0 && sLast > 0) { logger.info('search self-check OK', { vector: vLast, search: sLast }); return; }
    if (attempt < retries) await sleep(delayMs);
  }
  throw new Error(
    `search self-check FAILED after retries: $vectorSearch=${vLast} $search=${sLast} hits ` +
    '(index not ready or unpopulated)',
  );
}
