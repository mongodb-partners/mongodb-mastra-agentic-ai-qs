import type { Db } from 'mongodb';
import { logger } from '../observability/logger';
import type { EmbedFn } from './seed-transactions';
import {
  TRANSACTIONS_COLLECTION, TRANSACTIONS_VECTOR_INDEX, TRANSACTIONS_SEARCH_INDEX,
} from '../mastra/schemas/transactions';
import { VECTOR_CANDIDATE_FLOOR } from '../retrieval/pipelines';
import { estimatedCount } from './estimated-count';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Corpus size past which the retry window widens — see the `retries` default below. */
const LARGE_CORPUS_DOCS = 100_000;

export async function runSearchSelfCheck(
  db: Db, embed: EmbedFn, opts: { retries?: number; delayMs?: number } = {},
): Promise<void> {
  const col = db.collection(TRANSACTIONS_COLLECTION);
  // 8 retries x 2 s is ~16 s, which is right for a 12k corpus and far too short for a large one:
  // a 1M vector index can report READY on the Atlas side minutes before it answers queries, and
  // this check runs BEFORE the policies and session_resolutions steps, so timing out leaves
  // provisioning half-done. Observed on the live 1M cluster: restore finished 10:39:27Z and the
  // index only became queryable at 10:51:11Z — ~12 min. Widen the window with the corpus rather
  // than weakening the check, which is what catches an actually-empty cluster.
  const docCount = await estimatedCount(col);
  const retries = opts.retries ?? (docCount >= LARGE_CORPUS_DOCS ? 300 : 8);
  const delayMs = opts.delayMs ?? 2000;
  const [qvec] = await embed(['cash deposit just under the reporting threshold']);

  // Both probes retry: on a freshly (re)built index Atlas vector AND search are eventually
  // consistent, so newly-seeded docs may not be queryable for a few seconds. Poll until both
  // return hits, or fail loudly — this fence catches the "empty results on a fresh cluster"
  // demo-killer.
  let vLast = 0;
  let sLast = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const vHits = await col.aggregate([
      // Same shortlist floor the app's own pipelines use, so the check exercises the configuration
      // that will actually serve traffic (a binary-quantized index behaves differently at cand 50).
      { $vectorSearch: { index: TRANSACTIONS_VECTOR_INDEX, path: 'embedding', queryVector: qvec, numCandidates: VECTOR_CANDIDATE_FLOOR, limit: 3 } },
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
