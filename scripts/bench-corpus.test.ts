import { describe, it, expect } from 'vitest';
import { Binary, Decimal128 } from 'mongodb';
import {
  assertBenchTarget, argValue, buildManifest, redactUri, encodeRecord, decodeRecord, planRun,
  EXPORT_REPR,
} from './bench-corpus';
import { EMBED_MODEL } from '../src/mastra/embed';
import { EMBED_DIM } from '../src/mastra/schemas/transactions';
import { toBinData } from '../src/data/embedding-codec';

const BENCH_URI = 'mongodb+srv://u:p@bench-cluster.abc.mongodb.net/?retryWrites=true';

const record = {
  _id: 'oid',
  transaction_id: 'txn-syn-00001',
  text: 'a narrative',
  amount: 4950,
  currency: 'USD',
  sender: { name: 'Acme LLC', account_number: 'ACC-SYN-1001' },
  recipient: { name: 'Beta Inc', account_number: 'ACC-SYN-1002' },
  status: 'approved',
  lane: 'structuring',
  model_used: 'historical',
  embedding: toBinData(Array.from({ length: EMBED_DIM }, (_, i) => i / EMBED_DIM)),
  created_at: new Date('2026-01-02T03:04:05.000Z'),
};

describe('assertBenchTarget', () => {
  it('accepts a benchmark URI and defaults the database', () => {
    expect(assertBenchTarget({ BENCH_MONGODB_URI: BENCH_URI })).toEqual({
      uri: BENCH_URI, db: 'marshal_bench',
    });
  });

  it('refuses to fall back to MONGODB_URI', () => {
    // A fallback means a bare `npm run bench:seed` on a box targets that box's live cluster.
    expect(() => assertBenchTarget({ MONGODB_URI: BENCH_URI })).toThrow(/BENCH_MONGODB_URI is required/);
  });

  it('refuses BENCH_DB=marshal', () => {
    expect(() => assertBenchTarget({ BENCH_MONGODB_URI: BENCH_URI, BENCH_DB: 'marshal' }))
      .toThrow(/operational database/);
  });

  it('refuses a URI whose path names the operational database', () => {
    // The likelier accident than BENCH_DB: an Atlas connection string copied with its default db.
    expect(() => assertBenchTarget({
      BENCH_MONGODB_URI: 'mongodb+srv://u:p@bench-cluster.abc.mongodb.net/marshal?retryWrites=true',
    })).toThrow(/names the operational database/);
  });

  it('allows a URI path that merely starts with the forbidden name', () => {
    // marshal_bench must not be caught by a substring check on "marshal".
    expect(assertBenchTarget({
      BENCH_MONGODB_URI: 'mongodb+srv://u:p@c.abc.mongodb.net/marshal_bench',
    }).db).toBe('marshal_bench');
  });
});

describe('argValue', () => {
  it('reads --flag value and --flag=value', () => {
    expect(argValue(['seed', '--count', '1000'], 'count')).toBe('1000');
    expect(argValue(['seed', '--count=1000'], 'count')).toBe('1000');
  });
  it('returns undefined for a missing flag, and does not eat the next flag as a value', () => {
    expect(argValue(['seed'], 'count')).toBeUndefined();
    expect(argValue(['seed', '--count', '--drop'], 'count')).toBeUndefined();
  });
});

describe('planRun', () => {
  // Everything here is validated before a connection is opened. Server selection takes ~30s to time
  // out, so a typo'd subcommand used to report a connection error half a minute later and name the
  // wrong problem. Verified end-to-end: an unknown subcommand now exits 1 in 0.7s.
  const env = { BENCH_MONGODB_URI: BENCH_URI };

  it('resolves each subcommand to a runnable without touching the network', () => {
    for (const argv of [['seed', '--count', '10'], ['export', '--out', '/tmp/x.ndjson'], ['restore', '--in', '/tmp/x.ndjson']]) {
      expect(typeof planRun(argv, env).run).toBe('function');
    }
  });

  it('rejects a missing or non-positive --count before connecting', () => {
    expect(() => planRun(['seed'], env)).toThrow(/--count/);
    expect(() => planRun(['seed', '--count', '0'], env)).toThrow(/--count/);
    expect(() => planRun(['seed', '--count', '-5'], env)).toThrow(/--count/);
    expect(() => planRun(['seed', '--count', '1e6'], env)).not.toThrow(); // 1e6 is an integer
    expect(() => planRun(['seed', '--count', 'lots'], env)).toThrow(/--count/);
  });

  it('rejects a missing path for export and restore', () => {
    expect(() => planRun(['export'], env)).toThrow(/--out/);
    expect(() => planRun(['restore'], env)).toThrow(/--in/);
  });

  it('rejects an unknown or absent subcommand', () => {
    expect(() => planRun(['bogus'], env)).toThrow(/unknown subcommand/);
    expect(() => planRun([], env)).toThrow(/unknown subcommand/);
  });

  it('applies the target guard before argument parsing', () => {
    // Order matters: a run against the operational database must be refused whether or not the
    // rest of the command line is valid.
    expect(() => planRun(['seed', '--count', '10'], { ...env, BENCH_DB: 'marshal' }))
      .toThrow(/operational database/);
  });
});

describe('manifest', () => {
  it('records the model, dims, repr, tier and generator topology', () => {
    const m = buildManifest({ count: 1_000_000, tier: 'M30', cluster: 'c', db: 'marshal_bench', commit: 'abc123' });
    expect(m.model).toBe(EMBED_MODEL);
    expect(m.dims).toBe(EMBED_DIM);
    expect(m.repr).toBe(EXPORT_REPR);
    expect(m.benchmark_tier).toBe('M30');
    // The topology constants are what keep depth-3 $graphLookup under the 16MB cap; a corpus
    // generated under different values is a different graph at the same document count.
    expect(m.generator).toMatchObject({ seed: 42, account_pool: expect.any(Number), community_size: expect.any(Number) });
  });

  it('redacts credentials from the recorded cluster', () => {
    expect(redactUri(BENCH_URI)).not.toContain('u:p');
    expect(redactUri(BENCH_URI)).toContain('bench-cluster');
  });
});

describe('export/restore round trip', () => {
  it('survives a JSON round trip with byte-identical vectors', () => {
    const encoded = JSON.parse(JSON.stringify(encodeRecord(record)));
    const back = decodeRecord(encoded);
    expect((back.embedding as Binary).buffer).toEqual(record.embedding.buffer);
    expect(back.transaction_id).toBe(record.transaction_id);
    expect(back.created_at.getTime()).toBe(record.created_at.getTime());
  });

  it('restores the searchable vector subtype, not an opaque blob', () => {
    // A subtype-0 restore is the silent killer: Atlas reports the index READY and queryable and
    // $vectorSearch returns zero hits with no error (measured on M30 2026-07-27). A restored corpus
    // that cannot be searched looks exactly like a correct one until the sweep comes back empty.
    const back = decodeRecord(JSON.parse(JSON.stringify(encodeRecord(record))));
    expect((back.embedding as Binary).sub_type).toBe(Binary.SUBTYPE_VECTOR);
  });

  it('exports the header-free payload, so the artifact does not encode the BSON wrapper', () => {
    const b64 = String((encodeRecord(record) as Record<string, unknown>).embedding_b64);
    expect(Buffer.from(b64, 'base64').length).toBe(EMBED_DIM * 4); // 4096, not 4098
  });

  it('drops _id so a restore into a fresh collection cannot collide', () => {
    expect(encodeRecord(record)).not.toHaveProperty('_id');
  });

  it('tags the representation and refuses an untagged or unknown one on decode', () => {
    const encoded = encodeRecord(record) as Record<string, unknown>;
    expect(encoded.embedding_repr).toBe(EXPORT_REPR);
    expect(() => decodeRecord({ ...encoded, embedding_repr: 'int8' })).toThrow(/unknown embedding_repr/);
    expect(() => decodeRecord({ ...encoded, embedding_repr: undefined })).toThrow(/unknown embedding_repr/);
  });

  it('encodes a legacy BSON double array to the same bytes as BinData', () => {
    // Mid-migration a collection holds both forms; the export must normalise, not fork.
    const asArray = { ...record, embedding: Array.from({ length: EMBED_DIM }, (_, i) => i / EMBED_DIM) };
    expect(encodeRecord(asArray).embedding_b64).toBe(encodeRecord(record).embedding_b64);
  });

  it('refuses a truncated vector rather than inserting one that silently never matches', () => {
    const short = { ...encodeRecord(record), embedding_b64: Buffer.alloc(64).toString('base64') };
    expect(() => decodeRecord(short)).toThrow(/decodes to 64 bytes/);
  });

  it('throws on a document with no embedding at all', () => {
    const { embedding, ...noVec } = record;
    expect(() => encodeRecord(noVec)).toThrow(/no usable embedding/);
  });
});

describe('amount survives the export/restore round trip', () => {
  it('restores amount as a Decimal128, not a plain object', () => {
    // THE SILENT ONE. decodeRecord spreads ...rest straight out of JSON.parse, so without explicit
    // handling an exported {"$numberDecimal":"4950.00"} restores as a sub-document. Atlas accepts
    // it, nothing errors, and every amount in the 1M corpus becomes an object.
    const encoded = JSON.parse(JSON.stringify(encodeRecord({
      ...record,
      amount: Decimal128.fromString('4950.00'),
    })));
    const decoded = decodeRecord(encoded);
    expect(decoded.amount).toBeInstanceOf(Decimal128);
    expect((decoded.amount as unknown as Decimal128).toString()).toBe('4950.00');
  });

  it('preserves cents exactly through the round trip', () => {
    const encoded = JSON.parse(JSON.stringify(encodeRecord({
      ...record,
      amount: Decimal128.fromString('4950.75'),
    })));
    expect((decodeRecord(encoded).amount as unknown as Decimal128).toString()).toBe('4950.75');
  });

  it('normalizes a pre-migration numeric amount on export', () => {
    // The artifact on the Track B box was exported with int32 amounts. Restoring it must produce
    // Decimal128 too, or a restore would silently un-migrate the collection.
    const encoded = JSON.parse(JSON.stringify(encodeRecord({ ...record, amount: 4950 })));
    expect((decodeRecord(encoded).amount as unknown as Decimal128).toString()).toBe('4950.00');
  });

  it('rejects an artifact line whose amount is missing', () => {
    const encoded = JSON.parse(JSON.stringify(encodeRecord({ ...record, amount: 4950 })));
    delete (encoded as Record<string, unknown>).amount;
    expect(() => decodeRecord(encoded)).toThrow(/amount/i);
  });
});
