import { describe, it, expect } from 'vitest';
import { buildInvestigationAgent, runInvestigation, VerdictSchema, INVESTIGATION_SYSTEM, formatCase } from './investigation-agent';
import { SUBJECT_ACCOUNT_KEY } from './tools/retrieval-tools';
import { ToolCallRecorder } from './tool-recorder';

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

  it('system prompt tells the model NOT to guess an account number', () => {
    // The instruction used to be "call trace_funds on the sender's account_number" while the
    // narrative never contained one, so the model had to invent a value — measured on all three
    // models. The prompt must now point at the no-argument call instead.
    expect(INVESTIGATION_SYSTEM).toMatch(/no arguments/i);
    expect(INVESTIGATION_SYSTEM).toMatch(/do not guess an account number/i);
    // And it must say that a non-complete trace is missing evidence, not a clean result.
    expect(INVESTIGATION_SYSTEM).toMatch(/trace_status/);
  });

  describe('formatCase', () => {
    it('puts the account numbers in front of the narrative', () => {
      // The whole point of defect B: these values exist in the database but were never shown to the
      // model, so it could not use them and fabricated instead.
      const out = formatCase('Transfer of 900 USD from Quartz Trading to Vertex Holdings.', {
        transaction_id: 'txn-review-ring', sender_account: 'ACC-RING-A', recipient_account: 'ACC-RING-B',
      });
      expect(out).toMatch(/sender account: ACC-RING-A/);
      expect(out).toMatch(/recipient account: ACC-RING-B/);
      expect(out).toMatch(/narrative: Transfer of 900 USD/);
    });

    it('returns the bare narrative when there is no subject', () => {
      expect(formatCase('just prose')).toBe('just prose');
    });

    it('omits missing fields rather than rendering undefined', () => {
      // A line reading "sender account: undefined" is worse than no line: the model would pass it on.
      const out = formatCase('prose', { sender_account: 'ACC-1' });
      expect(out).toMatch(/sender account: ACC-1/);
      expect(out).not.toMatch(/undefined/);
      expect(out).not.toMatch(/recipient account/);
    });
  });


  const verdict = { recommendation: 'escalate', confidence: 70, risk_factors: ['high value'], rationale: 'r' };
  // A stub agent whose generate() returns the queued results in order, so we can drive the exact
  // sequence the real provider produces (a miss, then a hit).
  const stubAgent = (results: unknown[]) => {
    let i = 0;
    const calls = () => i;
    return { agent: { generate: async () => results[i++] } as any, calls };
  };

  it('passes the subject account to the tools via requestContext', async () => {
    // The channel trace_funds reads its default from. Asserted here because a typo in the key would
    // silently reinstate the original bug — the tool would find nothing and fail open.
    let seen: unknown;
    const agent = {
      generate: async (_m: unknown, opts: any) => {
        seen = opts?.requestContext?.get(SUBJECT_ACCOUNT_KEY);
        return { object: verdict };
      },
    } as any;
    await runInvestigation(agent, cfg, 'narrative', undefined, undefined, { sender_account: 'ACC-RING-A' });
    expect(seen).toBe('ACC-RING-A');
  });

  it('sends the account numbers in the user prompt, not just the context', async () => {
    let prompt = '';
    const agent = {
      generate: async (msgs: any) => { prompt = String(msgs?.[0]?.content ?? ''); return { object: verdict }; },
    } as any;
    await runInvestigation(agent, cfg, 'Transfer from Quartz Trading.', undefined, undefined, {
      transaction_id: 'txn-review-ring', sender_account: 'ACC-RING-A',
    });
    expect(prompt).toMatch(/ACC-RING-A/);
  });

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

describe('runInvestigation', () => {
  const cfg = {
    llmProvider: 'anthropic', llmModel: 'claude-haiku-4-5', voyageApiKey: 'x', mongoUri: 'x', mongoDb: 'marshal',
  } as any;

  it('passes the recorder hooks to generate() and commits the successful attempt', async () => {
    const rec = new ToolCallRecorder();
    const calls: any[] = [];
    const agent: any = {
      generate: async (_msgs: any, opts: any) => {
        calls.push(opts);
        // Mastra invokes the hooks around each tool execute; emulate one call inside the turn.
        opts.hooks.beforeToolCall({ toolName: 'hybrid_search', input: { query: 'q', k: 4 }, context: {} });
        opts.hooks.afterToolCall({ toolName: 'hybrid_search', input: { query: 'q', k: 4 }, context: {}, output: { results: [1, 2] } });
        return { object: { recommendation: 'approve', confidence: 90, risk_factors: [], rationale: 'ok' } };
      },
    };

    const v = await runInvestigation(agent, cfg, 'narrative', undefined, rec);
    expect(v.recommendation).toBe('approve');
    expect(calls[0].hooks).toBeDefined();
    expect(rec.drain().map(e => e.tool.name)).toEqual(['hybrid_search']);
  });

  it('does not record the tool calls of an attempt that produced no usable verdict', async () => {
    const rec = new ToolCallRecorder();
    let n = 0;
    const agent: any = {
      generate: async (_msgs: any, opts: any) => {
        n++;
        const tool = n === 1 ? 'search_text' : 'hybrid_search';
        opts.hooks.beforeToolCall({ toolName: tool, input: { query: 'q' }, context: {} });
        opts.hooks.afterToolCall({ toolName: tool, input: { query: 'q' }, context: {}, output: { results: [] } });
        // First attempt drops the object (the Bedrock miss this loop exists for); second succeeds.
        return n === 1
          ? { object: undefined, finishReason: 'stop' }
          : { object: { recommendation: 'escalate', confidence: 50, risk_factors: ['x'], rationale: 'r' } };
      },
    };

    await runInvestigation(agent, cfg, 'narrative', undefined, rec);
    expect(rec.drain().map(e => e.tool.name)).toEqual(['hybrid_search']);
  });

  it('runs without a recorder — the parameter is optional for eval and bench call sites', async () => {
    let i = 0;
    const agent = { generate: async () => ({ object: { recommendation: 'approve', confidence: 80, risk_factors: [], rationale: 'r' } }) } as any;
    const v = await runInvestigation(agent as any, cfg, 'narrative');
    expect(v.confidence).toBe(80);
  });
});
