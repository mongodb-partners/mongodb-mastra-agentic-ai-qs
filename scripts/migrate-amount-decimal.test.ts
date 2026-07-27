import { describe, it, expect } from 'vitest';
import {
  AMOUNT_PATHS, buildConvertPipeline, buildUnmigratedFilter, buildUpdateFilter,
} from './migrate-amount-decimal';

describe('AMOUNT_PATHS', () => {
  it('never includes a snapshot amount', () => {
    // snapshot.amount is bound into evidence_hash. Converting it changes the digest and makes
    // /api/reviews/:id/resolve reject every affected case as stale, permanently. This assertion is
    // the guard: if someone "completes" the path list by adding snapshot.amount, this fails.
    for (const entry of AMOUNT_PATHS) {
      for (const p of entry.paths) {
        expect(p).not.toMatch(/(^|\.)snapshot\./);
      }
    }
  });

  it('covers transactions.amount', () => {
    const txn = AMOUNT_PATHS.find(e => e.collection === 'transactions');
    expect(txn?.paths).toContain('amount');
  });

  it('covers the nested analysis paths in both live and replay collections', () => {
    for (const coll of ['case_analysis', 'replay_analysis']) {
      const entry = AMOUNT_PATHS.find(e => e.collection === coll);
      expect(entry, `${coll} must be migrated`).toBeDefined();
      expect(entry!.paths).toContain('amount');
      expect(entry!.paths).toContain('precedents.amount');
      expect(entry!.paths).toContain('ring.edges.amount');
    }
  });

  it('lists no collection twice', () => {
    const names = AMOUNT_PATHS.map(e => e.collection);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('buildConvertPipeline', () => {
  it('converts a top-level field to decimal', () => {
    const stages = buildConvertPipeline(['amount']);
    expect(JSON.stringify(stages)).toContain('"to":"decimal"');
    expect(JSON.stringify(stages)).toContain('$amount');
  });

  it('is a no-op pipeline for an empty path list', () => {
    expect(buildConvertPipeline([])).toEqual([]);
  });

  it('maps over an array path rather than overwriting the array', () => {
    // 'precedents.amount' must become a $map over precedents. A bare $set on
    // 'precedents.amount' would replace the ARRAY with a single value and destroy the precedents.
    const json = JSON.stringify(buildConvertPipeline(['precedents.amount']));
    expect(json).toContain('$map');
    expect(json).toContain('precedents');
  });

  it('preserves null and missing amounts instead of converting them to 0', () => {
    // $convert without onNull turns a missing field into null; with a 0 default it would invent
    // an amount of zero. Neither the pipeline nor the verification may fabricate a value.
    const json = JSON.stringify(buildConvertPipeline(['amount']));
    expect(json).toContain('onNull');
  });

  it('rounds to MONEY_SCALE so the bytes match what the app writes', () => {
    // Measured on M30 2026-07-27: a bare $convert turns int32 1256 into NumberDecimal("1256"),
    // while toMoney(1256) produces NumberDecimal("1256.00"). Equal by value, DIFFERENT bytes — so a
    // corpus half-migrated by this script and half written by the app is inconsistent on the wire.
    const stages = buildConvertPipeline(['amount']) as any[];
    expect(stages[0].$set.amount.$round).toBeDefined();
    expect(stages[0].$set.amount.$round[1]).toBe(2);
  });

  it('leaves an array element that has no amount untouched', () => {
    // Without this $cond, $mergeObjects ADDS amount:null to a ring edge that only had from/to —
    // measured — and that new null then matches the verification filter forever, so the migration
    // fails on its own output.
    const stages = buildConvertPipeline(['ring.edges.amount']) as any[];
    const inExpr = stages[0].$set['ring.edges'].$map.in;
    expect(inExpr.$cond).toBeDefined();
    expect(JSON.stringify(inExpr.$cond[0])).toContain('missing');
    expect(inExpr.$cond[1]).toBe('$$el');
  });
});

describe('buildUnmigratedFilter', () => {
  it('uses $elemMatch for an array path, not a dotted $not', () => {
    // Measured on M30 2026-07-27: {'precedents.amount': {$not: {$type: 'decimal'}}} does NOT mean
    // "some element is not a decimal" — $not negates the whole implicit $elemMatch, so it means
    // "NO element is a decimal". A half-converted array reports as clean, which is the exact
    // partial-failure this query exists to catch.
    const f = buildUnmigratedFilter('precedents.amount') as any;
    expect(f.precedents.$elemMatch).toBeDefined();
    expect(f['precedents.amount']).toBeUndefined();
  });

  it('anchors a nested array path at the array, not the sub-document', () => {
    const f = buildUnmigratedFilter('ring.edges.amount') as any;
    expect(f['ring.edges'].$elemMatch.amount).toBeDefined();
  });

  it('uses a plain predicate for a top-level path', () => {
    const f = buildUnmigratedFilter('amount') as any;
    expect(f.amount.$exists).toBe(true);
    expect(f.amount.$elemMatch).toBeUndefined();
  });

  it('excludes null from the unmigrated set at every path shape', () => {
    // A null amount cannot become a decimal (onNull preserves it deliberately), so counting it
    // means the verification never reaches zero and the script throws on a fully-migrated database.
    for (const path of ['amount', 'precedents.amount', 'ring.edges.amount']) {
      expect(JSON.stringify(buildUnmigratedFilter(path)), path).toContain('null');
    }
  });
});

describe('buildUpdateFilter', () => {
  it('never matches every document', () => {
    // A $set of a $map over a MISSING array writes an empty array, so an unguarded update gives a
    // document with no `ring` a `ring: {edges: []}` — a clean fund-trace it never had.
    for (const path of ['amount', 'precedents.amount', 'ring.edges.amount']) {
      expect(buildUpdateFilter(path), path).not.toEqual({});
    }
  });

  it('requires the field to exist for a top-level path', () => {
    expect(buildUpdateFilter('amount')).toEqual({ amount: { $exists: true } });
  });

  it('requires the prefix to actually be an array for an array path', () => {
    expect(buildUpdateFilter('precedents.amount')).toEqual({ precedents: { $type: 'array' } });
    expect(buildUpdateFilter('ring.edges.amount')).toEqual({ 'ring.edges': { $type: 'array' } });
  });
});
