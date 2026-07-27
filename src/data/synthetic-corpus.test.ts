import { describe, it, expect } from 'vitest';
import { Decimal128 } from 'mongodb';
import { generateSyntheticCorpus, SYNTHETIC_ID_PREFIX, COMMUNITY_SIZE } from './synthetic-corpus';
import { DECIDED_STATUSES, LANES, TransactionSchema } from '../mastra/schemas/transactions';

describe('generateSyntheticCorpus', () => {
  it('is deterministic for the same count and seed', () => {
    const a = generateSyntheticCorpus(300);
    const b = generateSyntheticCorpus(300);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('is a strict prefix when count grows (incremental seeding stays idempotent)', () => {
    const small = generateSyntheticCorpus(200);
    const large = generateSyntheticCorpus(500);
    expect(JSON.stringify(large.slice(0, 200))).toBe(JSON.stringify(small));
  });

  it('produces unique, prefixed ids and only DECIDED statuses (never pending)', () => {
    const corpus = generateSyntheticCorpus(500);
    const ids = new Set(corpus.map(r => r.transaction_id));
    expect(ids.size).toBe(500);
    for (const r of corpus) {
      expect(r.transaction_id.startsWith(SYNTHETIC_ID_PREFIX)).toBe(true);
      expect(DECIDED_STATUSES).toContain(r.status);
      expect(r.model_used).toBe('historical');
    }
  });

  it('covers every lane and skews toward clean traffic', () => {
    const corpus = generateSyntheticCorpus(1200);
    const byLane = new Map<string, number>();
    for (const r of corpus) byLane.set(r.lane, (byLane.get(r.lane) ?? 0) + 1);
    for (const lane of LANES) expect(byLane.get(lane) ?? 0).toBeGreaterThan(0);
    expect(byLane.get('clean_approve')! / corpus.length).toBeGreaterThan(0.4);
  });

  it('gives ring transactions genuine 3-account cycles for $graphLookup', () => {
    const corpus = generateSyntheticCorpus(1200);
    const ring = corpus.filter(r => r.lane === 'ring');
    expect(ring.length).toBeGreaterThanOrEqual(3);
    // Every ring account appears as both a sender and a recipient within the corpus (a cycle).
    const senders = new Set(ring.map(r => r.sender.account_number));
    const recipients = new Set(ring.map(r => r.recipient.account_number));
    const firstGroup = ring.filter(r => /^ACC-SYNRING-1[ABC]$/.test(r.sender.account_number));
    expect(firstGroup.length).toBe(3);
    for (const r of firstGroup) {
      expect(senders.has(r.recipient.account_number) || recipients.has(r.sender.account_number)).toBe(true);
    }
  });

  it('predates the curated seeds so demo cases sort first in the queue', () => {
    const corpus = generateSyntheticCorpus(300);
    const cutoff = Date.UTC(2026, 4, 1); // curated seeds start 2026-05
    for (const r of corpus) expect(r.created_at.getTime()).toBeLessThan(cutoff);
  });

  it('clusters non-ring accounts so a depth-3 closure stays inside the 16MB BSON cap at 1M', () => {
    // A uniform draw over the account pool makes the graph dense: at 1M each account sends
    // ~111 transactions, so a depth-3 $graphLookup closure reaches EVERY account and the
    // chain becomes the whole corpus — 929,958 edges = 102MB even after the $project,
    // 6.4x the hard 16MB limit. Communities bound the closure. 60k is big enough to show
    // the clustering and small enough to stay a unit test.
    const corpus = generateSyntheticCorpus(60_000);
    const nonRing = corpus.filter(r => r.lane !== 'ring');
    const community = (acc: string) => Math.floor((Number(acc.split('-')[2]) - 1000) / COMMUNITY_SIZE);
    const bridges = nonRing.filter(
      r => community(r.sender.account_number) !== community(r.recipient.account_number),
    ).length;
    const rate = bridges / nonRing.length;
    // Bridges must exist — without any, communities are disconnected islands and a
    // traversal can never discover anything, which defeats the point of the ring trace.
    expect(bridges).toBeGreaterThan(0);
    // But they stay rare enough to keep the closure bounded.
    expect(rate).toBeLessThan(0.01);
  });

  it('validates against the Transaction schema (minus embedding)', () => {
    const corpus = generateSyntheticCorpus(50);
    for (const r of corpus) {
      TransactionSchema.omit({ embedding: true }).parse(r);
    }
  });
});

describe('amount is Decimal128 without disturbing the narrative', () => {
  it('emits every amount as a Decimal128 at the money scale', () => {
    const corpus = generateSyntheticCorpus(500);
    for (const r of corpus) {
      expect(r.amount).toBeInstanceOf(Decimal128);
      expect(r.amount.toString()).toMatch(/^\d+\.\d{2}$/);
    }
  });

  it('keeps the narrative text byte-identical to the pre-migration output', () => {
    // GOLDEN VALUES, captured from the generator before the Decimal128 migration. These exact
    // strings are what get embedded, so they are also baked into every exported benchmark
    // artifact. If any of these assertions fails, the embeddings no longer match the corpus they
    // were generated from and every retrieval measurement taken against it is invalid — an
    // expensive failure that is otherwise completely silent.
    const corpus = generateSyntheticCorpus(1200);
    expect(corpus[0].text).toBe('Transfer of 1,256 USD from V. Iyer to Glacier Cold Chain; card-not-present purchase at an unrecognized overseas merchant, cardholder disputes the charge. Rejected as confirmed fraud.');
    expect(corpus[1].text).toBe('Quarterly vendor settlement of 2,464 USD from Clearspring Water Co to Peregrine Freight. Established relationship, consistent with prior activity, no anomalies.');
    expect(corpus[11].text).toBe('Monthly SaaS subscription renewal of 3,993 USD from Halcyon Motors to Copperline Utilities. Established relationship, consistent with prior activity, no anomalies.');
    expect(corpus[199].text).toBe('Insurance premium payment of 8,418 USD from Basalt Construction to Orchid Cosmetics. Established relationship, consistent with prior activity, no anomalies.');
  });

  it('never renders a decimal point or trailing cents into the text', () => {
    // The structural guard behind the golden values: money() must still receive a plain number.
    // A Decimal128 reaching it would render "1,256.00 USD" everywhere and change every embedding.
    const corpus = generateSyntheticCorpus(2000);
    for (const r of corpus) {
      expect(r.text).not.toMatch(/\d\.\d\d USD/);
    }
  });

  it('keeps the text amount and the stored amount numerically equal', () => {
    const corpus = generateSyntheticCorpus(300);
    for (const r of corpus) {
      const inText = r.text.match(/([\d,]+) USD/);
      expect(inText).not.toBeNull();
      expect(Number(inText![1].replace(/,/g, ''))).toBe(Number(r.amount.toString()));
    }
  });

  it('keeps ids and lanes identical to the pre-migration golden values', () => {
    // Pins that the PRNG stream did not shift — the prefix property depends on the draw count
    // per iteration, and a stray rng() call would reshuffle every lane assignment silently.
    const corpus = generateSyntheticCorpus(1200);
    expect(corpus[0].lane).toBe('clear_reject');
    expect(corpus[1].lane).toBe('clean_approve');
    expect(corpus[6].lane).toBe('ring');
    expect(corpus[7].lane).toBe('structuring');
    expect(corpus[9].lane).toBe('sanctions');
    expect(corpus[18].lane).toBe('high_value');
    expect(corpus[9].amount.toString()).toBe('53961.00');
    expect(corpus[18].amount.toString()).toBe('137872.00');
  });

  it('still validates against TransactionSchema', () => {
    // The corpus records have no embedding, so validate the money field via the schema's shape.
    for (const r of generateSyntheticCorpus(50)) {
      expect(TransactionSchema.safeParse({ ...r, embedding: new Array(1024).fill(0) }).success).toBe(true);
    }
  });
});
