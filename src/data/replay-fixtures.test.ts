import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BSON, Decimal128 } from 'mongodb';
import { evidenceHash, type EvidenceSnapshot } from '../workflow/evidence';

// Resolve from this file, not from process.cwd() — the convention in this codebase
// (`src/ingestion/transaction-fixtures.ts`), and it does not depend on where vitest was invoked.
const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'replay');
// Parse the way restore-replay.ts does. Plain JSON.parse would leave {$numberDecimal:"..."}
// wrappers in place and this test would assert on a shape the server never sees.
const load = (f: string) => BSON.EJSON.parse(readFileSync(join(DIR, `${f}.json`), 'utf8')) as any[];

describe('replay_analysis fixture', () => {
  const docs = load('replay_analysis');

  it('has the expected document count', () => {
    expect(docs).toHaveLength(6);
  });

  it('stores every top-level amount as Decimal128', () => {
    const amounts = docs.map(d => d.amount).filter(a => a !== undefined);
    expect(amounts).toHaveLength(6);
    for (const a of amounts) expect(a).toBeInstanceOf(Decimal128);
  });

  it('stores every precedent amount as Decimal128', () => {
    let n = 0;
    for (const d of docs) for (const p of d.precedents ?? []) {
      if (p.amount === undefined) continue;
      expect(p.amount).toBeInstanceOf(Decimal128);
      n++;
    }
    expect(n).toBe(20);
  });

  it('keeps every ring edge amount readable as money in either representation', () => {
    // NOT Decimal128, and that is correct. `RetrievalService.traceFundsGraph` builds these edges
    // with `Number(e.amount)` on purpose (see its comment): they go to the browser as JSON and into
    // ringSvg for coordinate arithmetic. So a recording captured from a live run carries plain
    // numbers here even on a fully migrated database, while the same field in an OLDER recording is
    // Decimal128 because `migrate-amount-decimal.ts` converted it in place.
    //
    // Asserting Decimal128 here pinned the migration's output rather than the app's contract, so it
    // failed the moment the recording was re-captured from a real run. The contract the app actually
    // relies on is that both forms decode — `moneyValue` in public/app.js handles the extended-JSON
    // wrapper and the bare number, and nothing server-side does arithmetic on this path.
    let n = 0;
    for (const d of docs) for (const e of d.ring?.edges ?? []) {
      if (e.amount === undefined) continue;
      const v = e.amount instanceof Decimal128 ? Number(e.amount.toString()) : Number(e.amount);
      expect(Number.isFinite(v) && v > 0, `${d.transaction_id} edge ${e.from}->${e.to}`).toBe(true);
      n++;
    }
    expect(n).toBe(7);
  });

  it('scales every Decimal128 amount to exactly two places', () => {
    // Scoped to the paths the server writes as Decimal128 — top-level and precedents. Ring edges are
    // excluded for the reason above: a bare number has no scale to assert.
    const all: Decimal128[] = [];
    for (const d of docs) {
      if (d.amount) all.push(d.amount);
      for (const p of d.precedents ?? []) if (p.amount) all.push(p.amount);
    }
    expect(all).toHaveLength(26);
    for (const a of all) expect(a.toString()).toMatch(/^\d+\.\d\d$/);
  });
});

describe('hashed snapshots are untouched', () => {
  // snapshot.amount is inside evidence_hash. It must stay a plain number in BOTH files, and every
  // frozen digest must still re-derive. Measured baseline: 8/8 re-derive before this task.
  it('keeps every snapshot.amount a plain number and every digest re-derivable', () => {
    let checked = 0;
    for (const file of ['replay_reviews', 'replay_analysis']) {
      for (const doc of load(file)) {
        if (!doc.evidence_hash || !doc.snapshot) continue;
        expect(typeof doc.snapshot.amount, `${file} ${doc.transaction_id} snapshot.amount`).toBe('number');
        expect(evidenceHash(doc.snapshot as EvidenceSnapshot), `${file} ${doc.transaction_id}`)
          .toBe(doc.evidence_hash);
        checked++;
      }
    }
    expect(checked).toBe(8);
  });
});

describe('replay_events fixture', () => {
  const docs = load('replay_events');

  // Deliberately NOT a document count. The total is a property of whichever run was captured — tool
  // calls in particular vary with what the model decided to call, so re-baking the recording from a
  // genuine live run moved it 49 → 51 and failed a test that was pinning an accident. What must hold
  // is the SHAPE: every pending case triaged, governed, and reaching exactly one terminal step.
  it('covers every case from triage through exactly one terminal step', () => {
    const byStep = (s: string) => docs.filter(d => d.step === s);
    const cases = new Set(docs.map(d => d.transaction_id));
    expect(cases.size).toBe(6);
    expect(byStep('triage')).toHaveLength(6);
    expect(byStep('govern')).toHaveLength(6);
    // commit = decided outright, suspend = held for a human. Together they account for all six, and
    // no case may appear in both.
    const terminal = [...byStep('commit'), ...byStep('suspend')].map(d => d.transaction_id);
    expect(terminal).toHaveLength(6);
    expect(new Set(terminal).size).toBe(6);
    // The sanctions lane is a deterministic hard reject BEFORE any LLM call (decision/core.ts), so
    // that case legitimately has no retrieve/reason/graph events. Hence 5, not 6.
    for (const step of ['retrieve', 'reason', 'graph', 'recall']) {
      expect(byStep(step), step).toHaveLength(5);
    }
    expect(docs.filter(d => d.step === 'tool').length).toBeGreaterThan(0);
  });

  it('formats triage amounts with cents, matching the live run-engine', () => {
    // run-engine.ts now emits formatMoney (Task 5), so a live investigation renders
    // "$75,000.00 · high_value". The recording must agree, or demo mode and the live box disagree
    // on screen for the same case — the exact drift `pnpm check:replay` exists to catch.
    const triage = docs.filter(d => d.step === 'triage');
    expect(triage).toHaveLength(6);
    for (const t of triage) {
      expect(t.detail, t.transaction_id).toMatch(/^\$[\d,]+\.\d\d · \w+$/);
    }
    const byId = Object.fromEntries(triage.map(t => [t.transaction_id, t.detail]));
    expect(byId['txn-review-high']).toBe('$75,000.00 · high_value');
    expect(byId['txn-review-struct']).toBe('$4,950.00 · structuring');
    expect(byId['txn-review-ring']).toBe('$900.00 · ring');
  });
});

describe('replay_meta fixture', () => {
  const meta = load('replay_meta')[0];
  const cases = new Set(load('replay_analysis').map(d => d.transaction_id));

  // THE ASSERTION WHOSE ABSENCE LET A WRONG NUMBER SHIP. The artifact went out carrying
  // corpus_size 1,000,015 and decided_precedents 1,000,012 for a recording of 6 cases — three
  // documents short of accounting for its own queue. Demo mode publishes both straight to the status
  // bar as "corpus … · precedents …", so the discrepancy was on screen at a public demo, and the only
  // way to notice was to subtract two seven-digit numbers that differ in the last three places.
  //
  // Root cause was in snapshotReplay, fixed there (it counted the cluster AFTER the run committed
  // dispositions). This checks the shipped artifact, because that is the thing visitors see: a future
  // bake from a mis-sequenced cluster, or a hand-edited meta doc, lands here.
  it('reconciles its own counts against the cases it covers', () => {
    expect(cases.size).toBe(6);
    // `status` partitions exactly into `pending` + DECIDED_STATUSES (TransactionSchema), so the
    // undecided remainder is fully determined — there is no third state for documents to hide in.
    expect(meta.corpus_size - meta.decided_precedents).toBe(cases.size);
  });

  it('carries the provenance a published latency claim needs', () => {
    // Demo mode publishes the recording's timings as latency_p50_ms and the per-stage tail. Those are
    // performance claims, and 'unknown' in any of these makes one uncheckable.
    for (const f of ['app_commit', 'atlas_tier', 'llm_model', 'source_db'] as const) {
      expect(typeof meta[f], f).toBe('string');
      expect(meta[f], f).not.toBe('unknown');
      expect(String(meta[f]).length, f).toBeGreaterThan(0);
    }
    expect(meta.recorded_at).toBeInstanceOf(Date);
  });
});
