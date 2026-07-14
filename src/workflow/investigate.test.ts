import { describe, it, expect } from 'vitest';
import { runCaseInvestigation, resolveReview } from './investigate';
import { evidenceHash, type EvidenceSnapshot } from './evidence';
import type { TxnFacts, AgentVerdict } from '../decision/core';

// Fake transactional db recording writes.
function fakeDb() {
  const writes: Record<string, any[]> = {};
  const db: any = {
    collection: (name: string) => {
      writes[name] ??= [];
      return {
        insertOne: async (doc: any) => writes[name].push({ op: 'insert', doc }),
        updateOne: async (filter: any, update: any) => writes[name].push({ op: 'update', filter, update }),
        find: () => ({ sort: () => ({ limit: () => ({ next: async () => null }) }) }),
      };
    },
    client: { withSession: async (fn: any) => fn({ withTransaction: async (t: any) => t() }) },
  };
  return { db, writes };
}

const facts = (o: Partial<TxnFacts> = {}): TxnFacts => ({ transaction_id: 't', amount: 3200, sender_account: 'A', ...o });
const verdict = (o: Partial<AgentVerdict> = {}): AgentVerdict => ({ recommendation: 'approve', confidence: 96, risk_factors: [], rationale: 'clean', ...o });

describe('runCaseInvestigation', () => {
  it('commits a clean auto-approve', async () => {
    const { db, writes } = fakeDb();
    const out = await runCaseInvestigation(db, 's', facts(), verdict(), 1, false, '2026-06-11T00:00:00Z');
    expect(out.phase).toBe('committed');
    expect(out.decision.disposition).toBe('approve');
    expect(writes['case_decisions']).toHaveLength(1);
  });

  it('suspends a structuring case into the review queue with an evidence hash', async () => {
    const { db, writes } = fakeDb();
    const out = await runCaseInvestigation(db, 's', facts({ amount: 4950 }), verdict({ recommendation: 'approve' }), 0.75, false, '2026-06-11T00:00:00Z');
    expect(out.phase).toBe('suspended');
    expect(out.evidence_hash).toBeTypeOf('string');
    expect(writes['reviews'][0].update.$set.status).toBe('pending_review');
    expect(writes['case_decisions']).toBeUndefined(); // nothing committed yet
  });

  it('suspends when governance holds even if the reconciler would approve', async () => {
    const { db } = fakeDb();
    const out = await runCaseInvestigation(db, 's', facts(), verdict(), 0.35, true, '2026-06-11T00:00:00Z');
    expect(out.phase).toBe('suspended');
  });

  it('a hard-compliance reject is COMMITTED, not suspended, even when governance holds (finding #1)', async () => {
    const { db, writes } = fakeDb();
    // sanctions_hit -> triage() returns a hard reject; a governance hold must NOT suspend it.
    const out = await runCaseInvestigation(db, 's', facts({ sanctions_hit: true }), verdict({ recommendation: 'approve' }), 0.35, true, '2026-06-11T00:00:00Z');
    expect(out.phase).toBe('committed');
    expect(out.decision.disposition).toBe('reject');
    expect(out.decision.decided_by).toBe('compliance');
    expect(writes['reviews']).toBeUndefined(); // never enqueued for human review
  });
});

describe('resolveReview (durable resume with drift check)', () => {
  const current: EvidenceSnapshot = {
    transaction_id: 't', proposed_disposition: 'escalate', amount: 4950,
    risk_factors: ['structuring_amount'], compliance_score: 0.75,
  };

  it('commits the human decision when the echoed hash matches current evidence', async () => {
    const { db, writes } = fakeDb();
    const r = await resolveReview(db, 's', {
      transaction_id: 't', human_decision: 'reject', echoed_evidence_hash: evidenceHash(current), current, now: '2026-06-11T00:02:00Z',
    });
    expect(r.status).toBe('committed');
    expect(writes['case_decisions'][0].doc.reviewed_by).toBe('human');
    expect(writes['case_decisions'][0].doc.decision).toBe('reject');
  });

  it('refuses to commit when evidence drifted after the human saw it (stale)', async () => {
    const { db, writes } = fakeDb();
    const staleHash = evidenceHash({ ...current, compliance_score: 0.9 }); // what the human saw
    const r = await resolveReview(db, 's', {
      transaction_id: 't', human_decision: 'approve', echoed_evidence_hash: staleHash, current, now: '2026-06-11T00:02:00Z',
    });
    expect(r.status).toBe('rejected_stale');
    expect(writes['case_decisions']).toBeUndefined();
  });
});
