import { Agent } from '@mastra/core/agent';
import type { Config } from '../config';
import { getLLM } from '../mastra/models';
import { ReviewerOutputSchema, type PolicyJudge } from './reviewer';

/** Build an LLM-backed policy judge (a Mastra agent with structured output) for the reviewer. */
export function buildPolicyJudge(cfg: Config): PolicyJudge {
  const agent = new Agent({
    id: 'policy-judge', name: 'policy-judge',
    instructions: 'You are a compliance policy reviewer. Given a proposed action and the RETRIEVED policies, list every policy the action VIOLATES. You may ONLY cite policy codes that appear in the prompt. Return {violations:[{policy_code,severity,cited_text}]}.',
    model: getLLM(cfg),
  });
  return async ({ action, policies }) => {
    const list = policies
      .map(p => `<policy code="${p.policy_code}" severity="${p.severity}">${p.policy_text}</policy>`)
      .join('\n');
    const res: any = await agent.generate(
      [{ role: 'user', content: `ACTION: ${action}\n\nRETRIEVED POLICIES:\n${list}\n\nReturn the violations.` }],
      { structuredOutput: { schema: ReviewerOutputSchema }, temperature: 0 } as any,
    );
    return res.object ?? { violations: [] };
  };
}
