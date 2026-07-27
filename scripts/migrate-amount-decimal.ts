/**
 * Migrate `amount` from int32 to Decimal128, in place, without changing any value.
 *
 * Idempotent: converting a value that is already a 2-scale decimal produces the identical value, so
 * re-running is safe and a partially-completed run resumes simply by being run again. Verified
 * against Atlas M30 on 2026-07-27 — a second pass reports `modifiedCount: 0`.
 *
 * Values are preserved exactly, which is what makes this cheap: the narrative `text` is untouched,
 * so all 1,000,000 embeddings, the vector index, and the exported benchmark artifact stay valid.
 * A migration that changed amounts would invalidate every embedding (the amount is interpolated
 * into `text`) and cost a ~1.4 h re-seed plus a fresh ~6 GB export.
 *
 * WHAT THIS DELIBERATELY DOES NOT TOUCH: `snapshot.amount`, in `reviews`/`replay_reviews` and
 * `case_analysis`/`replay_analysis`. That field is bound into `evidence_hash`, and
 * `POST /api/reviews/:id/resolve` re-derives the hash from the stored snapshot when a case has no
 * live analysis (src/server/routes.ts). Converting it changes the digest, and the case is then
 * rejected as stale on every future attempt. See AMOUNT_PATHS.
 *
 * Usage — the database name is REQUIRED and never defaulted:
 *   MONGODB_URI=... npx tsx scripts/migrate-amount-decimal.ts --db marshal_bench
 *   MONGODB_URI=... npx tsx scripts/migrate-amount-decimal.ts --db marshal --dry-run
 */
import { MongoClient, type Db, type Document, type Filter } from 'mongodb';
import { pathToFileURL } from 'node:url';
import { MONEY_SCALE } from '../src/money';

/**
 * Every amount-bearing path, per collection. Enumerated from the live documents and the replay
 * fixtures on 2026-07-27, not guessed: `case_analysis` carries an amount at four different depths.
 *
 * `snapshot.amount` is absent BY DESIGN — see the module comment. A test asserts its absence.
 */
export const AMOUNT_PATHS: { collection: string; paths: string[] }[] = [
  { collection: 'transactions', paths: ['amount'] },
  { collection: 'case_analysis', paths: ['amount', 'precedents.amount', 'ring.edges.amount'] },
  { collection: 'replay_analysis', paths: ['amount', 'precedents.amount', 'ring.edges.amount'] },
  // reviews/replay_reviews hold ONLY snapshot.amount, which must not be converted. Listed with an
  // empty path set so the collection is visibly accounted for rather than looking overlooked.
  { collection: 'reviews', paths: [] },
  { collection: 'replay_reviews', paths: [] },
];

/**
 * Convert to a Decimal128 carrying exactly MONEY_SCALE fractional digits.
 *
 * `$round` to MONEY_SCALE, NOT a bare `$convert`. Measured on M30 2026-07-27: `$convert` alone
 * turns int32 `1256` into `NumberDecimal("1256")` — no fractional digits — while `toMoney(1256)` in
 * the application produces `NumberDecimal("1256.00")`. Both compare and arithmetic-equal, but they
 * are DIFFERENT BYTE ENCODINGS, so a corpus half-written by this script and half by the app is
 * inconsistent on the wire and in any digest taken over the raw bytes. `$round` also makes the
 * migration idempotent for a value the app already wrote at 2-scale.
 *
 * `onNull: null` so a null amount stays null rather than becoming a fabricated zero.
 */
function convertExpr(ref: string): Document {
  return {
    $round: [{ $convert: { input: ref, to: 'decimal', onNull: null, onError: null } }, MONEY_SCALE],
  };
}

/**
 * Match documents that still hold a non-decimal at `path`.
 *
 * Two measured subtleties, both of which the obvious query gets wrong:
 *
 * 1. For an array path, `{'precedents.amount': {$not: {$type: 'decimal'}}}` does NOT mean "some
 *    element is not a decimal". `$not` negates the whole implicitly-$elemMatch'd predicate, so it
 *    means "NO element is a decimal" — a half-converted array (one decimal, one int) matches
 *    nothing and reports as clean. That is exactly the silent partial-failure this query exists to
 *    catch, so array paths use an explicit `$elemMatch`.
 * 2. `null` must be excluded from the "unmigrated" set. A null amount cannot become a decimal
 *    (`onNull: null` preserves it deliberately), so counting it means the verification never
 *    reaches zero and the script throws on a database it has fully migrated.
 */
export function buildUnmigratedFilter(path: string): Filter<Document> {
  const notDecimal = { $exists: true, $not: { $type: ['decimal', 'null'] } };
  if (!path.includes('.')) return { [path]: notDecimal };
  const segments = path.split('.');
  const field = segments.pop()!;
  return { [segments.join('.')]: { $elemMatch: { [field]: notDecimal } } };
}

/**
 * Build the `$set` stages for an update-with-pipeline.
 *
 * A dotted path whose prefix is an ARRAY needs a `$map`, not a plain `$set`: `$set` on
 * `precedents.amount` replaces the whole `precedents` array with one value. Only single-level
 * array paths occur here (`precedents.amount`, `ring.edges.amount`), so the map handles the last
 * segment and the prefix addresses the array.
 *
 * The `$cond` inside the map is load-bearing. Without it, `$mergeObjects` ADDS `amount: null` to an
 * element that never had one — measured on a `ring.edges` entry with only `from`/`to`. That new
 * null then matches the verification filter forever, so the script would fail on its own output.
 *
 * The array must be selected by `buildUpdateFilter` too, for the same class of reason: a `$set` of
 * a `$map` over a MISSING array writes an empty array, so a document with no `ring` acquires
 * `ring: { edges: [] }` and starts claiming a clean fund-trace it never had.
 */
export function buildConvertPipeline(paths: string[]): Document[] {
  if (!paths.length) return [];
  const set: Document = {};
  for (const path of paths) {
    if (!path.includes('.')) {
      set[path] = convertExpr(`$${path}`);
      continue;
    }
    const segments = path.split('.');
    const field = segments.pop()!;
    const arrayPath = segments.join('.');
    set[arrayPath] = {
      $map: {
        input: `$${arrayPath}`,
        as: 'el',
        in: {
          $cond: [
            { $eq: [{ $type: `$$el.${field}` }, 'missing'] },
            '$$el',
            { $mergeObjects: ['$$el', { [field]: convertExpr(`$$el.${field}`) }] },
          ],
        },
      },
    };
  }
  return [{ $set: set }];
}

/**
 * Which documents the update may touch, for one path.
 *
 * Deliberately NOT `{}`. An update-with-pipeline over every document writes the field into
 * documents that never had it — see buildConvertPipeline. One updateMany per path, each with its
 * own guard, rather than one combined update: a combined `$set` cannot express "only where THIS
 * path exists" per field.
 */
export function buildUpdateFilter(path: string): Filter<Document> {
  if (!path.includes('.')) return { [path]: { $exists: true } };
  const segments = path.split('.');
  segments.pop();
  return { [segments.join('.')]: { $type: 'array' } };
}

/** How many documents still hold a non-decimal value at `path`. The verification query. */
export async function countUnmigrated(db: Db, collection: string, path: string): Promise<number> {
  return db.collection(collection).countDocuments(buildUnmigratedFilter(path));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dbName = argv[argv.indexOf('--db') + 1];
  const dryRun = argv.includes('--dry-run');
  const uri = process.env.MONGODB_URI;

  if (!uri) throw new Error('MONGODB_URI is required');
  // Never default the database. A default here would silently migrate whichever database the URI
  // happens to point at — including an operational one during a benchmark run.
  if (!dbName || dbName.startsWith('--')) {
    throw new Error('--db <name> is required (e.g. --db marshal_bench)');
  }

  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = client.db(dbName);
    const present = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name));

    for (const { collection, paths } of AMOUNT_PATHS) {
      if (!present.has(collection)) {
        console.log(`${collection}: absent in ${dbName}, skipping`);
        continue;
      }
      if (!paths.length) {
        console.log(`${collection}: no convertible paths (snapshot.amount is hashed — left as is)`);
        continue;
      }

      if (dryRun) {
        const counts = await Promise.all(paths.map(p => countUnmigrated(db, collection, p)));
        console.log(
          `${collection}: DRY RUN — would convert ` +
          paths.map((p, i) => `${p} (${counts[i].toLocaleString()})`).join(', '),
        );
        continue;
      }

      // One update per path, each guarded — see buildUpdateFilter for why not one combined update.
      const summary: string[] = [];
      for (const p of paths) {
        const before = await countUnmigrated(db, collection, p);
        const res = await db.collection(collection).updateMany(
          buildUpdateFilter(p), buildConvertPipeline([p]),
        );
        const after = await countUnmigrated(db, collection, p);
        summary.push(`${p}: ${before.toLocaleString()} -> ${after.toLocaleString()} (modified ${res.modifiedCount.toLocaleString()})`);
        if (after > 0) {
          console.log(`${collection}: ${summary.join('; ')}`);
          throw new Error(`${collection} still holds ${after} non-decimal amount(s) at ${p}`);
        }
      }
      console.log(`${collection}: ${summary.join('; ')}`);
    }

    // Report a sample so the operator sees the shape, not just a success line.
    if (present.has('transactions') && !dryRun) {
      const sample = await db.collection('transactions').findOne({}, { projection: { amount: 1, currency: 1, _id: 0 } });
      console.log(`sample: ${JSON.stringify(sample)}  (scale ${MONEY_SCALE})`);
    }
  } finally {
    await client.close();
  }
}

// Only run when executed directly, so the unit test can import the pure helpers above. Same
// entrypoint check as bench-corpus.ts — an exact URL comparison, not a substring match on argv.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
