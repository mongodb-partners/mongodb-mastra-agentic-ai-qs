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

  it('stores every ring edge amount as Decimal128', () => {
    let n = 0;
    for (const d of docs) for (const e of d.ring?.edges ?? []) {
      if (e.amount === undefined) continue;
      expect(e.amount).toBeInstanceOf(Decimal128);
      n++;
    }
    expect(n).toBe(7);
  });

  it('scales every converted amount to exactly two places', () => {
    const all: Decimal128[] = [];
    for (const d of docs) {
      if (d.amount) all.push(d.amount);
      for (const p of d.precedents ?? []) if (p.amount) all.push(p.amount);
      for (const e of d.ring?.edges ?? []) if (e.amount) all.push(e.amount);
    }
    expect(all).toHaveLength(33);
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

  it('has the expected document count', () => {
    expect(docs).toHaveLength(49);
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
