import { describe, it, expect } from 'vitest';
import { buildInvestigationAgent, VerdictSchema, INVESTIGATION_SYSTEM } from './investigation-agent';

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
});
