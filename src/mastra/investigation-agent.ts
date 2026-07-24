import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import type { Config } from '../config';
import { logger } from '../observability/logger';
import { getLLM, maxTokensFor, temperatureFor } from './models';
import { buildRetrievalTools } from './tools/retrieval-tools';
import type { RetrievalService } from '../retrieval/service';

/** The typed verdict the agent must emit. Code (decision/core.reconcile) has the final word. */
export const VerdictSchema = z.object({
  recommendation: z.enum(['approve', 'reject', 'escalate']),
  confidence: z.number().min(0).max(100),
  risk_factors: z.array(z.string()),
  rationale: z.string(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

export const INVESTIGATION_SYSTEM = `You are a financial fraud investigator. For the transaction under review:
1. Call hybrid_search to retrieve similar ALREADY-DECIDED precedent cases.
2. Call trace_funds on the sender's account_number to check for ring / mule / circular-flow patterns.
3. Optionally call recall_verdicts to cite how closely-similar prior cases were resolved.
4. Weigh the precedents, the fund-tracing signal, and the amount. Then produce a single verdict:
   { recommendation: approve|reject|escalate, confidence: 0-100, risk_factors: string[], rationale: string }.
Recommend escalate whenever you are uncertain, the amount is high-value, it looks like structuring
(a deposit just under a reporting threshold), or fund-tracing looks suspicious. Be concise and specific;
ground every risk_factor in a tool result. You do NOT make the final decision — a deterministic policy
layer and a human reviewer follow you.`;

/** Build the investigation agent with the retrieval tools bound to a RetrievalService. */
export function buildInvestigationAgent(cfg: Config, svc: RetrievalService, modelOverride?: string): Agent {
  const tools = buildRetrievalTools(svc);
  return new Agent({
    id: 'investigation-agent',
    name: 'investigation-agent',
    instructions: INVESTIGATION_SYSTEM,
    model: getLLM(cfg, modelOverride),
    tools: {
      hybrid_search: tools.hybridSearch,
      search_precedent: tools.searchPrecedent,
      search_text: tools.searchText,
      trace_funds: tools.traceFunds,
      recall_verdicts: tools.recallVerdicts,
    },
  });
}

/**
 * How many times to ask the model for a verdict before giving up. See runInvestigation — a
 * tool-using structured-output turn occasionally ends with an empty final message, and that is
 * transient, so the cheapest correct fix is to ask again.
 */
const VERDICT_ATTEMPTS = 3;

/** Run the agent over a case narrative and return its typed verdict. */
export async function runInvestigation(
  agent: Agent, cfg: Config, caseNarrative: string, modelOverride?: string,
): Promise<Verdict> {
  const model = modelOverride || cfg.llmModel;
  const prompt = `Review this transaction and produce your verdict:\n\n${caseNarrative}`;

  // WHY THE RETRY LOOP: `structuredOutput` is not guaranteed to produce an object. Observed on
  // Bedrock (us.anthropic.claude-haiku-4-5), roughly 1 run in 5: the agent issues its tool calls,
  // then ends the turn with `finishReason: 'stop'`, an EMPTY text body and no error — so
  // `res.object` is undefined. Returning that unchecked handed a bare `undefined` to the caller,
  // which blew up one frame later on `verdict.recommendation`. It is a transient generation miss,
  // not a bad case or a misconfiguration (the same transaction succeeds on the next attempt), so
  // retry and validate here rather than making every call site defensive.
  let last = '';
  for (let attempt = 1; attempt <= VERDICT_ATTEMPTS; attempt++) {
    const res = await agent.generate(
      [{ role: 'user', content: prompt }],
      {
        structuredOutput: { schema: VerdictSchema },
        maxSteps: 8,
        maxTokens: maxTokensFor(model),
        temperature: temperatureFor(model),
      } as any,
    );

    // Re-validate instead of trusting the cast: this is the boundary where model output becomes
    // typed data, and a shape that only *looks* right (missing risk_factors, confidence out of
    // range) would otherwise surface as a downstream crash or a bogus stored verdict.
    const parsed = VerdictSchema.safeParse((res as any).object);
    if (parsed.success) return parsed.data;

    last = (res as any).object === undefined
      ? `empty structured output (finishReason=${(res as any).finishReason})`
      : parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    logger.warn('verdict attempt produced no usable object', { attempt, attempts: VERDICT_ATTEMPTS, model, reason: last });
  }
  throw new Error(`agent produced no valid verdict after ${VERDICT_ATTEMPTS} attempts — ${last}`);
}
