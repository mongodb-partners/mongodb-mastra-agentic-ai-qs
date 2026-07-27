import { describe, it, expect, vi } from 'vitest';
import { RetrievalService } from './service';

// Fake Db that records the pipeline passed to aggregate and returns scripted docs. `throws` makes
// toArray() reject instead, for the server-error paths.
function fakeDb(returnDocs: any[], throws?: { code?: number; message?: string }) {
  const calls: any[][] = [];
  const db = {
    collection() {
      return {
        aggregate(pipeline: any[]) {
          calls.push(pipeline);
          return {
            toArray: async () => {
              if (throws) {
                const err: any = new Error(throws.message ?? 'server error');
                if (throws.code !== undefined) err.code = throws.code;
                throw err;
              }
              return returnDocs;
            },
          };
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

  describe('the $graphLookup memory limit (code 40099)', () => {
    // Measured at 1M documents: a traversal from a densely-connected account exceeds
    // $graphLookup's hard 100MB in-memory ceiling, which it cannot spill to disk. Propagating it
    // aborted the whole case before governance, the audit write and the human-review gate.
    it('traceFunds() degrades to no-ring-found instead of throwing', async () => {
      const { db } = fakeDb([], { code: 40099, message: '$graphLookup reached maximum memory consumption' });
      const svc = new RetrievalService(db as any, embed);
      const ring = await svc.traceFunds('ACC-WIDE');
      expect(ring.suspicious_patterns).toBe(false);
      expect(ring.network_size).toBe(0);
    });

    it('traceFundsGraph() degrades to an empty edge list', async () => {
      const { db } = fakeDb([], { code: 40099 });
      const svc = new RetrievalService(db as any, embed);
      const ring = await svc.traceFundsGraph('ACC-WIDE');
      expect(ring.edges).toEqual([]);
      expect(ring.circular_flow).toBe(false);
    });

    it('does NOT swallow any other server error', async () => {
      // An auth failure or a dropped connection reported as "fund-trace clean" would be a silent
      // loss of evidence — the case would reach a decision on a signal that was never measured.
      const { db } = fakeDb([], { code: 13, message: 'not authorized' });
      const svc = new RetrievalService(db as any, embed);
      await expect(svc.traceFunds('A')).rejects.toThrow('not authorized');
      await expect(svc.traceFundsGraph('A')).rejects.toThrow('not authorized');
    });

    it('does not swallow an error with no code at all', async () => {
      const { db } = fakeDb([], { message: 'connection reset' });
      const svc = new RetrievalService(db as any, embed);
      await expect(svc.traceFunds('A')).rejects.toThrow('connection reset');
    });
  });
});
