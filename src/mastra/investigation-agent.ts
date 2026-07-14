import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import type { Config } from '../config';
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

/** Run the agent over a case narrative and return its typed verdict. */
export async function runInvestigation(
  agent: Agent, cfg: Config, caseNarrative: string, modelOverride?: string,
): Promise<Verdict> {
  const model = modelOverride || cfg.llmModel;
  const res = await agent.generate(
    [{ role: 'user', content: `Review this transaction and produce your verdict:\n\n${caseNarrative}` }],
    {
      structuredOutput: { schema: VerdictSchema },
      maxSteps: 8,
      maxTokens: maxTokensFor(model),
      temperature: temperatureFor(model),
    } as any,
  );
  return (res as any).object as Verdict;
}
