import { describe, it, expect, vi } from 'vitest';
import { commitCaseDecision, enqueueReview } from './case-store';

// Fake transactional db: records writes; provides client.withSession + session.withTransaction.
function fakeDb() {
  const writes: Record<string, any[]> = {};
  const col = (name: string) => {
    writes[name] ??= [];
    return {
      insertOne: async (doc: any, opts?: any) => { writes[name].push({ op: 'insert', doc, session: opts?.session }); },
      updateOne: async (filter: any, update: any, opts?: any) => { writes[name].push({ op: 'update', filter, update, session: opts?.session }); },
      find: () => ({ sort: () => ({ limit: () => ({ next: async () => null }) }) }),
    };
  };
  // Sentinel session; the code passes it to collection ops as { session } inside withTransaction,
  // so tests can assert an op ran in-transaction by checking write.session === SESSION.
  const SESSION: any = { sentinel: true, withTransaction: async (t: any) => t() };
  const db: any = {
    collection: (name: string) => col(name),
    client: { withSession: async (fn: any) => fn(SESSION) },
  };
  return { db, writes, SESSION };
}

describe('commitCaseDecision', () => {
  it('writes decision + transaction status + case + audit in one flow', async () => {
    const { db, writes } = fakeDb();
    await commitCaseDecision(db, 'secret', {
      transaction_id: 'txn-1', disposition: 'approve', confidence: 95,
      risk_factors: [], rationale: 'clean', reviewed_by: 'agent', compliance_score: 1,
      now: '2026-06-11T00:00:00Z',
    });
    expect(writes['case_decisions'][0].doc.decision).toBe('approve');
    expect(writes['transactions'][0].update.$set.status).toBe('approved');
    expect(writes['cases'][0].update.$set.state).toBe('CLEARED');
    expect(writes['audit_trail'][0].op).toBe('insert');
    expect(writes['audit_trail'][0].doc.current_hash).toBeTypeOf('string');
    // Atomicity (finding #3): the audit insert must run INSIDE the transaction (carry the session),
    // so a decision can never be committed without its audit-chain entry.
    expect(writes['audit_trail'][0].session).toBeDefined();
    expect(writes['case_decisions'][0].session).toBeDefined();
  });

  it('maps reject/escalate dispositions to the right transaction status', async () => {
    const { db, writes } = fakeDb();
    await commitCaseDecision(db, 's', { transaction_id: 't', disposition: 'reject', confidence: 90, risk_factors: ['x'], rationale: 'r', reviewed_by: 'human', compliance_score: 0.35, now: '2026-06-11T00:00:00Z' });
    expect(writes['transactions'][0].update.$set.status).toBe('rejected');
  });

  it('throws without a transactional client', async () => {
    await expect(commitCaseDecision({ collection: () => ({}) } as any, 's', {
      transaction_id: 't', disposition: 'approve', confidence: 1, risk_factors: [], rationale: '', reviewed_by: 'agent', compliance_score: 1, now: 'x',
    })).rejects.toThrow(/transactional/);
  });
});

describe('enqueueReview', () => {
  it('writes a pending review + flips the case to PENDING_REVIEW', async () => {
    const { db, writes } = fakeDb();
    await enqueueReview(db, { transaction_id: 't', flag_reason: 'structuring', rules_triggered: ['structuring_amount'], evidence_hash: 'abc', snapshot: { transaction_id: 't' }, now: '2026-06-11T00:00:00Z' });
    expect(writes['reviews'][0].update.$set.status).toBe('pending_review');
    expect(writes['cases'][0].update.$set.state).toBe('PENDING_REVIEW');
    expect(writes['cases'][0].update.$set.evidence_hash).toBe('abc');
  });
});
