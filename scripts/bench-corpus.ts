/**
 * Seed, export and restore the 1M benchmark corpus in `marshal_bench`.
 *
 * Separate from `provision-and-seed.ts` on purpose. That script is the operational bringup: it
 * upserts the 15 curated demo cases, re-seeds policies (which fires the "POLICY UPDATED LIVE"
 * banner on every connected console), and runs the search self-check. None of that belongs in a
 * benchmark run, and all of it is destructive to a live demo.
 *
 * Three subcommands:
 *   seed     generate → embed → insert, incremental so an interrupted run resumes
 *   export   stream the whole collection to NDJSON + MANIFEST.json, embeddings included
 *   restore  read that NDJSON back, so the corpus is re-creatable WITHOUT re-embedding
 *
 * Why export before benchmarking rather than after: embedding is the only expensive step
 * (~0.6 h per million through the gateway). A bad sweep, a wrong index, a dropped collection —
 * none of those should ever cost the embedding run again. Export first, sweep second.
 *
 * Usage (all three require BENCH_MONGODB_URI explicitly — see assertBenchTarget):
 *   BENCH_MONGODB_URI=… npm run bench:seed    -- --count 1000000
 *   BENCH_MONGODB_URI=… npm run bench:export  -- --out /data/bench-1m.ndjson
 *   BENCH_MONGODB_URI=… npm run bench:restore -- --in  /data/bench-1m.ndjson
 *
 * Run these ON THE TRACK B BOX. From a laptop the WAN leg dominates every number and inverts
 * model and index comparisons.
 */
import { createWriteStream, createReadStream, writeFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MongoClient, Binary, type Decimal128, type Collection, type Db, type Document } from 'mongodb';
import type { Config } from '../src/config';
import { toMoney } from '../src/money';
import { logger } from '../src/observability/logger';
import { getQueryEmbedder, EMBED_MODEL } from '../src/mastra/embed';
import {
  TRANSACTIONS_COLLECTION, EMBED_DIM, type Transaction,
} from '../src/mastra/schemas/transactions';
import {
  generateSyntheticCorpus, SYNTHETIC_ID_PREFIX, ACCOUNT_POOL, COMMUNITY_SIZE, BRIDGE_RATE,
} from '../src/data/synthetic-corpus';
import { toBinData, fromBinData, toFloat32Bytes } from '../src/data/embedding-codec';
import {
  provisionGraphIndexes, provisionTransactionVectorIndex, provisionTransactionSearchIndex,
} from '../src/data/provision-transactions';

/** Marker written into every exported record and asserted on restore. */
export const EXPORT_REPR = 'binData-float32-base64';

/** Database names this script must never touch, whatever the environment says. */
export const FORBIDDEN_DBS = ['marshal'] as const;

/** Documents per insert batch. Also the embed unit — embedDocuments re-chunks to its own 96. */
const BATCH = 500;

/**
 * The last line of defence for the operational database. Every subcommand calls this first.
 *
 * Two failure modes, not one. The obvious one is `BENCH_DB=marshal`. The likelier one is the URI:
 * an Atlas SRV string can carry a default database in its path (`…mongodb.net/marshal?…`), and this
 * script's own `--count` semantics are destructive — `seed` deletes surplus synthetic documents, so
 * pointed at `marshal` with a small count it would delete most of the live precedent corpus. So the
 * db name is checked in both places it can come from.
 *
 * BENCH_MONGODB_URI is deliberately required rather than falling back to MONGODB_URI. A fallback
 * means a bare `npm run bench:seed` on a box silently targets that box's operational cluster, which
 * is exactly the accident being guarded against.
 */
export function assertBenchTarget(env: Record<string, string | undefined>): { uri: string; db: string } {
  const uri = env.BENCH_MONGODB_URI;
  if (!uri) {
    throw new Error(
      'BENCH_MONGODB_URI is required (it does NOT fall back to MONGODB_URI — that fallback would ' +
      'point a benchmark run at the operational cluster).',
    );
  }
  const db = env.BENCH_DB || 'marshal_bench';
  for (const forbidden of FORBIDDEN_DBS) {
    if (db === forbidden) {
      throw new Error(`refusing to run: BENCH_DB is "${db}", the operational database`);
    }
    // Path component of the SRV/standard URI, before any query string.
    const path = uri.split('?')[0].split('/')[3];
    if (path === forbidden) {
      throw new Error(
        `refusing to run: BENCH_MONGODB_URI names the operational database "${forbidden}" in its path`,
      );
    }
  }
  return { uri, db };
}

/** `--flag value` and `--flag=value`, both forms, no dependency. */
export function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(`--${flag}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const inline = argv.find(a => a.startsWith(`--${flag}=`));
  return inline?.slice(flag.length + 3);
}

/**
 * Everything needed to tell two corpora apart that otherwise look identical.
 *
 * This exists because of a real failure: a corpus that looked right but was embedded under a
 * different model stranded 12 of 13 precedent citations, and nothing in the data said so. Cross-
 * generation vectors do not error — the dimensions still match — so the manifest is the only place
 * the generation is recorded, and `restore` refuses on a mismatch.
 *
 * The topology constants are here for the same reason at the graph layer: COMMUNITY_SIZE and
 * BRIDGE_RATE are what keep a depth-3 `$graphLookup` under the 16 MB BSON cap, and a corpus
 * generated under different values is a different graph with the same document count.
 */
export interface BenchManifest {
  count: number;
  model: string;
  dims: number;
  repr: string;
  /** Atlas tier the corpus was seeded and measured on. Numbers are not portable across tiers. */
  benchmark_tier: string;
  source: { cluster: string; db: string; collection: string };
  generator: { seed: number; id_prefix: string; account_pool: number; community_size: number; bridge_rate: number };
  app_commit: string;
}

export function buildManifest(o: {
  count: number; tier: string; cluster: string; db: string; commit: string;
}): BenchManifest {
  return {
    count: o.count,
    model: EMBED_MODEL,
    dims: EMBED_DIM,
    repr: EXPORT_REPR,
    benchmark_tier: o.tier,
    source: { cluster: o.cluster, db: o.db, collection: TRANSACTIONS_COLLECTION },
    generator: {
      seed: 42, id_prefix: SYNTHETIC_ID_PREFIX, account_pool: ACCOUNT_POOL,
      community_size: COMMUNITY_SIZE, bridge_rate: BRIDGE_RATE,
    },
    app_commit: o.commit,
  };
}

/** Strip credentials from a URI so the manifest can record which cluster without leaking a password. */
export function redactUri(uri: string): string {
  return uri.replace(/\/\/[^@/]*@/, '//');
}

/**
 * NDJSON, one document per line, rather than one JSON array: a 1M-document array must be fully
 * buffered by both writer and reader, and at ~4.6 KB/document that is several GB of heap. Lines
 * stream in constant memory on both sides.
 *
 * The embedding is base64 of the raw little-endian float32 bytes. `JSON.stringify` on a Binary
 * emits an unspecified object shape, so it is converted explicitly and tagged with
 * `embedding_repr`, which restore asserts — an untagged blob is indistinguishable from a
 * differently-encoded one.
 */
export function encodeRecord(doc: Document): Document {
  const { _id, embedding, ...rest } = doc;
  if (!(embedding instanceof Binary) && !Array.isArray(embedding)) {
    throw new Error(`document ${doc.transaction_id} has no usable embedding`);
  }
  // The header-free float32 payload, so the artifact does not encode the BSON wrapper. Both stored
  // representations — and both Binary subtypes — normalise to the same bytes.
  return {
    ...rest,
    created_at: (rest.created_at as Date).toISOString(),
    // A decimal STRING, not JSON.stringify's {"$numberDecimal":...} object and not a JSON number.
    // The object form restores as a sub-document (see decodeRecord); a JSON number would round-trip
    // through a binary float and reintroduce exactly the imprecision Decimal128 is here to avoid.
    amount: toMoney(rest.amount as Decimal128 | number).toString(),
    embedding_b64: toFloat32Bytes(embedding).toString('base64'),
    embedding_repr: EXPORT_REPR,
  };
}

export function decodeRecord(line: Document): Transaction {
  if (line.embedding_repr !== EXPORT_REPR) {
    throw new Error(`unknown embedding_repr ${JSON.stringify(line.embedding_repr)} (want ${EXPORT_REPR})`);
  }
  const { embedding_b64, embedding_repr, amount, ...rest } = line;
  if (amount === undefined || amount === null) {
    throw new Error(`document ${line.transaction_id} has no amount`);
  }
  const buf = Buffer.from(String(embedding_b64), 'base64');
  if (buf.length !== EMBED_DIM * 4) {
    throw new Error(
      `document ${line.transaction_id} decodes to ${buf.length} bytes, want ${EMBED_DIM * 4}`,
    );
  }
  return {
    ...rest,
    created_at: new Date(String(rest.created_at)),
    // Back to Decimal128 explicitly. Spreading `...rest` would leave a JSON string (or, for an
    // artifact written by JSON.stringify of a raw Decimal128, a {$numberDecimal} sub-document) —
    // Atlas stores either without complaint, and every amount in the corpus stops being a number.
    // `toMoney` takes both a decimal string (new lines) and a JSON number (the existing 6 GB
    // artifact, exported with int32 amounts), so an old artifact restores already migrated.
    amount: toMoney(amount as string | number),
    // Back through the codec, NOT `new Binary(buf)`: that would restore a subtype-0 blob, which
    // Atlas leaves out of the vector index while reporting the index READY and queryable and
    // returning zero hits with no error. Measured on M30 2026-07-27. `fromBinData` handles the
    // 4-byte-alignment trap that a decoded Buffer can trip; a raw Float32Array view cannot.
    embedding: toBinData(fromBinData(new Binary(buf))),
  } as unknown as Transaction;
}

/** Which ids are already present, so an interrupted seed resumes instead of restarting. */
async function existingIds(col: Collection<Document>): Promise<Set<string>> {
  const ids = new Set<string>();
  const cursor = col.find(
    { transaction_id: { $regex: `^${SYNTHETIC_ID_PREFIX}` } },
    { projection: { transaction_id: 1, _id: 0 } },
  );
  for await (const d of cursor) ids.add(String(d.transaction_id));
  return ids;
}

/**
 * Generate → embed → insert.
 *
 * Resumable and additive. Unlike `seedSyntheticCorpus`, this does NOT delete surplus documents on a
 * lower count: at 1M the surplus is the expensive thing in the database, and a mistyped `--count`
 * should not destroy 0.6 h of embedding. Shrinking the corpus is an explicit `--drop`.
 *
 * `ordered: false` so one duplicate id does not abort the batch — a resumed run can race its own
 * previous tail.
 */
async function seed(db: Db, count: number, drop: boolean): Promise<void> {
  const col = db.collection(TRANSACTIONS_COLLECTION);
  if (drop) {
    // readWrite excludes dropDatabase, so drop the collection rather than the database.
    await col.drop().catch(() => { /* absent is fine */ });
    logger.info('dropped benchmark collection', { collection: TRANSACTIONS_COLLECTION });
  }

  const embedder = getQueryEmbedder(loadBenchConfig());
  const wanted = generateSyntheticCorpus(count);
  const have = await existingIds(col);
  const missing = wanted.filter(r => !have.has(r.transaction_id));
  logger.info('bench seed starting', {
    db: db.databaseName, target: count, present: have.size, toWrite: missing.length,
    model: EMBED_MODEL, dims: EMBED_DIM, repr: 'binData-float32',
  });

  let written = 0;
  let lastLogged = 0;
  for (let i = 0; i < missing.length; i += BATCH) {
    const chunk = missing.slice(i, i + BATCH);
    const vectors = await embedder.embedDocuments(chunk.map(r => r.text));
    const docs: Document[] = [];
    for (const [j, rec] of chunk.entries()) {
      const vec = vectors[j];
      // A short vector inserts fine and then silently returns nothing from $vectorSearch for that
      // document forever. Refuse it here rather than discovering it as a recall dip in the sweep.
      if (!Array.isArray(vec) || vec.length !== EMBED_DIM) {
        throw new Error(
          `embedding for ${rec.transaction_id} has ${Array.isArray(vec) ? vec.length : typeof vec} ` +
          `dims, want ${EMBED_DIM} — aborting so the corpus stays uniform`,
        );
      }
      docs.push({ ...rec, embedding: toBinData(vec) });
    }
    await col.insertMany(docs as any, { ordered: false });
    written += docs.length;
    if (written - lastLogged >= 50_000) {
      logger.info('bench seed progress', { written, of: missing.length });
      lastLogged = written;
    }
  }

  await provisionGraphIndexes(db);
  await col.createIndex({ transaction_id: 1 }, { unique: true });
  await col.createIndex({ status: 1 });
  await provisionTransactionVectorIndex(db);
  await provisionTransactionSearchIndex(db);
  logger.info('bench seed complete', {
    count: await col.countDocuments(), model: EMBED_MODEL, dims: EMBED_DIM, repr: 'binData-float32',
  });
}

/** Export the collection to NDJSON plus a sibling MANIFEST.json. */
async function exportCorpus(db: Db, uri: string, out: string, tier: string, commit: string): Promise<void> {
  const col = db.collection(TRANSACTIONS_COLLECTION);
  const stream = createWriteStream(out, { encoding: 'utf8' });
  let n = 0;
  for await (const doc of col.find({}, { sort: { transaction_id: 1 } })) {
    // Honour backpressure: at 1M x ~6 KB of JSON, ignoring the return of write() buffers the whole
    // corpus in memory.
    if (!stream.write(`${JSON.stringify(encodeRecord(doc))}\n`)) await once(stream, 'drain');
    n++;
    if (n % 100_000 === 0) logger.info('bench export progress', { written: n });
  }
  stream.end();
  await once(stream, 'finish');

  const manifestPath = join(dirname(out), 'MANIFEST.json');
  const manifest = buildManifest({
    count: n, tier, cluster: redactUri(uri), db: db.databaseName, commit,
  });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  logger.info('bench export complete', { out, manifest: manifestPath, count: n });
}

/**
 * Restore from NDJSON without re-embedding.
 *
 * Refuses on a model mismatch: restoring voyage-3.5 vectors into a build that queries with voyage-4
 * measures P@1 = 0.10 and reports no error anywhere, which is the whole reason the manifest records
 * the model.
 */
async function restore(db: Db, input: string): Promise<void> {
  const manifestPath = join(dirname(input), 'MANIFEST.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BenchManifest;
  if (manifest.model !== EMBED_MODEL) {
    throw new Error(
      `manifest was embedded with ${manifest.model} but this build queries with ${EMBED_MODEL}. ` +
      'Cross-generation vectors do not error, they just return the wrong neighbours (P@1 0.10). ' +
      'Re-embed the corpus instead of restoring this artifact.',
    );
  }
  if (manifest.dims !== EMBED_DIM) {
    throw new Error(`manifest dims ${manifest.dims} != EMBED_DIM ${EMBED_DIM}`);
  }

  const col = db.collection(TRANSACTIONS_COLLECTION);
  const lines = createInterface({ input: createReadStream(input, { encoding: 'utf8' }), crlfDelay: Infinity });
  let batch: Document[] = [];
  let n = 0;
  const flush = async () => {
    if (!batch.length) return;
    await col.insertMany(batch as any, { ordered: false });
    n += batch.length;
    batch = [];
    if (n % 100_000 === 0) logger.info('bench restore progress', { inserted: n });
  };
  for await (const line of lines) {
    if (!line.trim()) continue;
    batch.push(decodeRecord(JSON.parse(line)) as unknown as Document);
    if (batch.length >= BATCH) await flush();
  }
  await flush();

  await provisionGraphIndexes(db);
  await col.createIndex({ transaction_id: 1 }, { unique: true });
  await col.createIndex({ status: 1 });
  await provisionTransactionVectorIndex(db);
  await provisionTransactionSearchIndex(db);
  logger.info('bench restore complete', { inserted: n, expected: manifest.count, model: manifest.model });
}

/**
 * Config for the embedder only. `loadConfig` demands MONGODB_URI, which a benchmark run has no
 * business supplying — the Mongo target comes from BENCH_MONGODB_URI via assertBenchTarget — so
 * build the minimal shape the Voyage client actually reads instead of widening the app schema.
 */
function loadBenchConfig(): Config {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) throw new Error('VOYAGE_API_KEY is required to embed the benchmark corpus');
  return { voyageApiKey: key, voyageBaseUrl: process.env.VOYAGE_BASE_URL } as Config;
}

/**
 * Validate the whole invocation BEFORE opening a connection. Deliberate ordering: server selection
 * takes ~30 s to time out, so a typo'd subcommand or a missing `--out` otherwise reports a
 * connection error half a minute later and names the wrong problem entirely.
 */
export function planRun(argv: string[], env: Record<string, string | undefined>): {
  uri: string; db: string; run: (db: Db, uri: string) => Promise<void>;
} {
  const cmd = argv[0];
  const { uri, db } = assertBenchTarget(env);
  switch (cmd) {
    case 'seed': {
      const count = Number(argValue(argv, 'count') ?? 0);
      if (!Number.isInteger(count) || count <= 0) throw new Error('--count <positive integer> is required');
      const drop = argv.includes('--drop');
      return { uri, db, run: d => seed(d, count, drop) };
    }
    case 'export': {
      const out = argValue(argv, 'out');
      if (!out) throw new Error('--out <path.ndjson> is required');
      const tier = argValue(argv, 'tier') ?? env.BENCH_TIER ?? 'unknown';
      const commit = argValue(argv, 'commit') ?? env.BENCH_COMMIT ?? 'unknown';
      return { uri, db, run: (d, u) => exportCorpus(d, u, out, tier, commit) };
    }
    case 'restore': {
      const input = argValue(argv, 'in');
      if (!input) throw new Error('--in <path.ndjson> is required');
      return { uri, db, run: d => restore(d, input) };
    }
    default:
      throw new Error(`unknown subcommand ${JSON.stringify(cmd)} — expected seed | export | restore`);
  }
}

async function main(): Promise<void> {
  try { process.loadEnvFile(); } catch { /* .env optional */ }
  const { uri, db: dbName, run } = planRun(process.argv.slice(2), process.env);

  const client = new MongoClient(uri);
  try {
    await client.connect();
    await run(client.db(dbName), uri);
  } finally {
    await client.close();
  }
}

// Only run when executed directly, so the unit test can import the pure helpers above. Same
// entrypoint check as export-replay.ts — an exact URL comparison, not a substring match on argv.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit(0)).catch(err => {
    logger.error('bench-corpus failed', { err: String(err) });
    process.exit(1);
  });
}
