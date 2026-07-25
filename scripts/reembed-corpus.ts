/**
 * Re-embed every stored document with the CURRENT `EMBED_MODEL`.
 *
 * Why this exists as its own script rather than being folded into `npm run seed`: the seeders are
 * deliberately incremental. `seedSyntheticCorpus` skips any transaction_id that already exists, so
 * after an embedding-model change a plain reseed would leave the entire synthetic corpus holding
 * vectors from the OLD model while queries use the new one. Dimensions still match (1024), so nothing
 * errors — retrieval just gets quietly worse. That is the failure mode this script prevents.
 *
 * Covers both embedded collections:
 *   - `transactions` — the precedent corpus behind $vectorSearch / $rankFusion.
 *   - `policies`     — the governance corpus behind the policy reviewer.
 *
 * Text is re-embedded from each document's own stored source field, so this is a pure vector refresh:
 * no narrative is regenerated and no id changes. Safe to re-run; idempotent for a given model.
 *
 * Usage:  npm run reembed          (add --dry-run to report counts without writing)
 */
import { MongoClient, type Collection, type Document } from 'mongodb';
import { loadConfig } from '../src/config';
import { logger } from '../src/observability/logger';
import { getQueryEmbedder, EMBED_MODEL, EMBED_BATCH_SIZE } from '../src/mastra/embed';
import { TRANSACTIONS_COLLECTION, EMBED_DIM } from '../src/mastra/schemas/transactions';
import { POLICIES_COLLECTION } from '../src/governance/policies';

const DRY_RUN = process.argv.includes('--dry-run');

/** Each target names the collection, the field holding the source text, and a label for logs. */
const TARGETS = [
  { collection: TRANSACTIONS_COLLECTION, textField: 'text', idField: 'transaction_id' },
  { collection: POLICIES_COLLECTION, textField: 'policy_text', idField: 'policy_code' },
] as const;

async function reembed(
  col: Collection<Document>,
  textField: string,
  idField: string,
  embed: (texts: string[]) => Promise<number[][]>,
): Promise<{ updated: number; skipped: number; badDim: number }> {
  const docs = await col
    .find({ [textField]: { $type: 'string', $ne: '' } }, { projection: { _id: 1, [textField]: 1, [idField]: 1 } })
    .toArray();

  let updated = 0;
  let badDim = 0;
  for (let start = 0; start < docs.length; start += EMBED_BATCH_SIZE) {
    const chunk = docs.slice(start, start + EMBED_BATCH_SIZE);
    const vectors = await embed(chunk.map(d => String(d[textField])));

    const ops = [];
    for (const [i, doc] of chunk.entries()) {
      const vec = vectors[i];
      // Guard the corpus: a short/empty vector would pass schemaless insert and then silently
      // break $vectorSearch for that document. Refuse to write it.
      if (!Array.isArray(vec) || vec.length !== EMBED_DIM) {
        badDim++;
        logger.warn('skipping document with unusable embedding', {
          id: doc[idField], got: Array.isArray(vec) ? vec.length : typeof vec, want: EMBED_DIM,
        });
        continue;
      }
      ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { embedding: vec } } } });
    }

    if (ops.length && !DRY_RUN) await col.bulkWrite(ops, { ordered: false });
    updated += ops.length;
    logger.info('re-embedded batch', {
      collection: col.collectionName, done: Math.min(start + chunk.length, docs.length), of: docs.length,
    });
  }

  const total = await col.countDocuments({});
  return { updated, skipped: total - docs.length, badDim };
}

async function main() {
  try { process.loadEnvFile(); } catch { /* .env optional */ }
  const cfg = loadConfig();
  const client = new MongoClient(cfg.mongoUri);
  try {
    await client.connect();
    const db = client.db(cfg.mongoDb);
    const embedder = getQueryEmbedder(cfg);

    logger.info('re-embed starting', { model: EMBED_MODEL, db: cfg.mongoDb, dry_run: DRY_RUN });

    for (const t of TARGETS) {
      const res = await reembed(
        db.collection(t.collection), t.textField, t.idField,
        texts => embedder.embedDocuments(texts),
      );
      logger.info('re-embed complete', { collection: t.collection, model: EMBED_MODEL, ...res });
      if (res.badDim > 0) throw new Error(`${t.collection}: ${res.badDim} documents got an unusable embedding`);
    }

    logger.info(DRY_RUN ? 're-embed dry run complete (nothing written)' : 're-embed complete');
  } finally {
    await client.close();
  }
}

main().then(() => process.exit(0)).catch(err => {
  logger.error('re-embed failed', { err: String(err) });
  process.exit(1);
});
