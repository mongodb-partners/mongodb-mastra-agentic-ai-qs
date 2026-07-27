import { describe, it, expect } from 'vitest';
import { judgeWithRetry, buildJudgePrompt, JudgeUnavailableError, JUDGE_ATTEMPTS } from './judge';

const ok = { object: { violations: [{ policy_code: 'AML-STRUCT-001', severity: 'high', cited_text: 'structuring' }] } };
/** What Bedrock actually returns on the miss this retry exists for: no object, no error. */
const miss = { object: undefined, finishReason: 'stop' };

describe('judgeWithRetry', () => {
  it('returns the verdict on the first attempt when the model behaves', async () => {
    let calls = 0;
    const r = await judgeWithRetry(async () => { calls++; return ok; }, 'p');
    expect(calls).toBe(1);
    expect(r.violations).toHaveLength(1);
  });

  it('retries a structured-output miss and returns the later success', async () => {
    // The regression this guards: the old `res.object ?? { violations: [] }` turned this exact
    // sequence into "no violations" on the FIRST response and never asked again.
    const responses = [miss, miss, ok];
    let calls = 0;
    const r = await judgeWithRetry(async () => responses[calls++], 'p');
    expect(calls).toBe(3);
    expect(r.violations[0].policy_code).toBe('AML-STRUCT-001');
  });

  it('throws rather than reporting zero violations when every attempt misses', async () => {
    // The load-bearing assertion. An empty violation list scores 1.0 and clears the hold threshold,
    // so a silent default here would auto-commit a case that was never actually reviewed.
    let calls = 0;
    await expect(judgeWithRetry(async () => { calls++; return miss; }, 'p'))
      .rejects.toThrow(JudgeUnavailableError);
    expect(calls).toBe(JUDGE_ATTEMPTS);
  });

  it('retries a malformed object, not just a missing one', async () => {
    // Wrong shape is as unusable as absent: severity is not in the enum.
    const bad = { object: { violations: [{ policy_code: 'X', severity: 'catastrophic', cited_text: 'c' }] } };
    const responses = [bad, ok];
    let calls = 0;
    const r = await judgeWithRetry(async () => responses[calls++], 'p');
    expect(calls).toBe(2);
    expect(r.violations[0].severity).toBe('high');
  });

  it('reports the reason it gave up, distinguishing empty output from a bad shape', async () => {
    await expect(judgeWithRetry(async () => miss, 'p', 1))
      .rejects.toThrow(/empty structured output \(finishReason=stop\)/);
    await expect(judgeWithRetry(async () => ({ object: { violations: 'nope' } }), 'p', 1))
      .rejects.toThrow(/violations/);
  });
});

describe('buildJudgePrompt', () => {
  it('renders only the retrieved codes, which bounds what the judge may cite', () => {
    const p = buildJudgePrompt('approve a wire', [
      { policy_code: 'AML-STRUCT-001', policy_text: 'no structuring', severity: 'high' },
    ]);
    expect(p).toContain('ACTION: approve a wire');
    expect(p).toContain('<policy code="AML-STRUCT-001" severity="high">no structuring</policy>');
  });
});
