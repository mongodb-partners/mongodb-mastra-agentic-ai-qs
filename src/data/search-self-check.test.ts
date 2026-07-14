import { describe, it, expect } from 'vitest';
import { runSearchSelfCheck } from './search-self-check';

// Each attempt calls aggregate twice (vector probe, then search probe). `perAttempt` supplies
// the [vectorHits, searchHits] pair returned on each attempt, in order.
function fakeDb(perAttempt: Array<[any[], any[]]>) {
  let call = 0;
  const flat = perAttempt.flat();
  return {
    collection() {
      return {
        aggregate() {
          const r = flat[Math.min(call, flat.length - 1)];
          call++;
          return { toArray: async () => r };
        },
      };
    },
  };
}
const embed = async (texts: string[]) => texts.map(() => Array.from({ length: 1024 }, () => 0.1));

describe('runSearchSelfCheck', () => {
  it('passes when both probes return hits', async () => {
    const db = fakeDb([[[{ transaction_id: 'x' }], [{ transaction_id: 'y' }]]]);
    await expect(runSearchSelfCheck(db as any, embed)).resolves.toBeUndefined();
  });

  it('throws when a probe keeps returning no results', async () => {
    const db = fakeDb([[[], []]]); // both probes empty on every attempt
    await expect(runSearchSelfCheck(db as any, embed, { retries: 1, delayMs: 0 })).rejects.toThrow(/self-check/i);
  });
});
