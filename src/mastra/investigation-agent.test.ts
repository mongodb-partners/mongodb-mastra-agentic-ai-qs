import { describe, it, expect } from 'vitest';
import { buildInvestigationAgent, runInvestigation, VerdictSchema, INVESTIGATION_SYSTEM } from './investigation-agent';

const cfg = {
  llmProvider: 'anthropic', llmModel: 'claude-haiku-4-5', voyageApiKey: 'x', mongoUri: 'x', mongoDb: 'marshal',
} as any;
const svc = {
  vector: async () => [], lexical: async () => [], hybrid: async () => [],
  traceFunds: async () => ({ network_size: 0, unique_accounts: 0, circular_flow: false, layering: false, suspicious_patterns: false }),
} as any;

describe('investigation agent', () => {
  it('VerdictSchema validates a well-formed verdict and rejects a bad one', () => {
    expect(() => VerdictSchema.parse({ recommendation: 'escalate', confidence: 80, risk_factors: ['x'], rationale: 'r' })).not.toThrow();
    expect(() => VerdictSchema.parse({ recommendation: 'maybe', confidence: 80, risk_factors: [], rationale: 'r' })).toThrow();
    expect(() => VerdictSchema.parse({ recommendation: 'approve', confidence: 150, risk_factors: [], rationale: 'r' })).toThrow();
  });

  it('builds an agent wired with the five retrieval tools', () => {
    const agent = buildInvestigationAgent(cfg, svc);
    expect(agent.name).toBe('investigation-agent');
  });

  it('system prompt instructs the tool sequence and defers the final decision', () => {
    expect(INVESTIGATION_SYSTEM).toMatch(/hybrid_search/);
    expect(INVESTIGATION_SYSTEM).toMatch(/trace_funds/);
    expect(INVESTIGATION_SYSTEM).toMatch(/do NOT make the final decision/i);
  });

  const verdict = { recommendation: 'escalate', confidence: 70, risk_factors: ['high value'], rationale: 'r' };
  // A stub agent whose generate() returns the queued results in order, so we can drive the exact
  // sequence the real provider produces (a miss, then a hit).
  const stubAgent = (results: unknown[]) => {
    let i = 0;
    const calls = () => i;
    return { agent: { generate: async () => results[i++] } as any, calls };
  };

  it('retries when structuredOutput yields no object, then returns the verdict', async () => {
    // Reproduces the observed Bedrock behaviour: finishReason 'stop' with object undefined.
    const { agent, calls } = stubAgent([{ finishReason: 'stop', object: undefined }, { object: verdict }]);
    await expect(runInvestigation(agent, cfg, 'narrative')).resolves.toEqual(verdict);
    expect(calls()).toBe(2);
  });

  it('retries when the object is present but fails schema validation', async () => {
    const { agent, calls } = stubAgent([{ object: { recommendation: 'maybe', confidence: 900 } }, { object: verdict }]);
    await expect(runInvestigation(agent, cfg, 'narrative')).resolves.toEqual(verdict);
    expect(calls()).toBe(2);
  });

  it('throws after exhausting the attempts instead of returning undefined', async () => {
    // The pre-fix bug: an unchecked `undefined` reached the caller and crashed on .recommendation.
    const { agent, calls } = stubAgent(Array.from({ length: 3 }, () => ({ finishReason: 'stop', object: undefined })));
    await expect(runInvestigation(agent, cfg, 'narrative')).rejects.toThrow(/no valid verdict after 3 attempts/);
    expect(calls()).toBe(3);
  });

  it('does not retry when the first attempt is already valid', async () => {
    const { agent, calls } = stubAgent([{ object: verdict }]);
    await expect(runInvestigation(agent, cfg, 'narrative')).resolves.toEqual(verdict);
    expect(calls()).toBe(1);
  });
});
