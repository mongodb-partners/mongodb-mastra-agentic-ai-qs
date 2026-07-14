import { describe, it, expect, vi } from 'vitest';
import { RetrievalService } from './service';

// Fake Db that records the pipeline passed to aggregate and returns scripted docs.
function fakeDb(returnDocs: any[]) {
  const calls: any[][] = [];
  const db = {
    collection() {
      return {
        aggregate(pipeline: any[]) {
          calls.push(pipeline);
          return { toArray: async () => returnDocs };
        },
      };
    },
  };
  return { db, calls };
}
const embed = vi.fn(async () => Array.from({ length: 1024 }, () => 0.02));

describe('RetrievalService', () => {
  it('vector() embeds the query and runs a $vectorSearch pipeline', async () => {
    const { db, calls } = fakeDb([{ transaction_id: 't1' }]);
    const svc = new RetrievalService(db as any, embed);
    const hits = await svc.vector('structuring', 3);
    expect(embed).toHaveBeenCalledWith('structuring');
    expect(calls[0][0].$vectorSearch).toBeDefined();
    expect(hits[0].transaction_id).toBe('t1');
  });

  it('lexical() runs a $search pipeline without embedding', async () => {
    const { db, calls } = fakeDb([{ transaction_id: 't2' }]);
    const svc = new RetrievalService(db as any, embed);
    await svc.lexical('cash deposit', 5);
    expect(calls[0][0].$search).toBeDefined();
  });

  it('hybrid() runs a $rankFusion pipeline', async () => {
    const { db, calls } = fakeDb([{ transaction_id: 't3' }]);
    const svc = new RetrievalService(db as any, embed);
    await svc.hybrid('ring', 5);
    expect(calls[0][0].$rankFusion).toBeDefined();
  });

  it('traceFunds() summarizes a graphLookup chain into ring signals', async () => {
    const doc = {
      chain: [
        { sender: { account_number: 'A' }, recipient: { account_number: 'B' }, amount: 900 },
        { sender: { account_number: 'B' }, recipient: { account_number: 'A' }, amount: 850 },
      ],
    };
    const { db } = fakeDb([doc]);
    const svc = new RetrievalService(db as any, embed);
    const ring = await svc.traceFunds('A');
    expect(ring.circular_flow).toBe(true);
    expect(ring.suspicious_patterns).toBe(true);
  });
});
