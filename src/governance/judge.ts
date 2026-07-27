import { Agent } from '@mastra/core/agent';
import type { Config } from '../config';
import { getLLM } from '../mastra/models';
import { logger } from '../observability/logger';
import { ReviewerOutputSchema, type PolicyJudge } from './reviewer';

/**
 * Attempts to get a usable structured verdict out of the judge. Same count, and the same reason, as
 * `VERDICT_ATTEMPTS` in src/mastra/investigation-agent.ts.
 */
export const JUDGE_ATTEMPTS = 3;

/** Raised when the judge could not produce a valid verdict. Callers MUST fail closed on this. */
export class JudgeUnavailableError extends Error {
  constructor(reason: string) {
    super(`policy judge produced no valid verdict after ${JUDGE_ATTEMPTS} attempts — ${reason}`);
    this.name = 'JudgeUnavailableError';
  }
}

/** The one Mastra call the judge makes. Injected so the retry logic is testable without a model. */
export type JudgeGenerate = (prompt: string) => Promise<unknown>;

/**
 * Ask the judge for violations, retrying a transient structured-output miss and validating the
 * result before it becomes typed data.
 *
 * WHY THIS IS NOT `res.object ?? { violations: [] }`. `structuredOutput` is not guaranteed to
 * produce an object — measured on Bedrock (us.anthropic.claude-haiku-4-5) at roughly 1 call in 5,
 * the turn ends with `finishReason: 'stop'`, an empty body and no error, so `res.object` is
 * undefined (the same failure documented on the investigation agent, which already retries).
 *
 * Defaulting that to an empty violation list is the DANGEROUS direction to fail. An empty list is
 * not "unknown", it is the affirmative claim "this action violates no policy": it scores 1.0 in
 * `computeComplianceScore`, so `held` is false and a case that should have been routed to a human
 * auto-commits with a clean compliance record and an audit entry attesting to it. A generation blip
 * silently became a governance decision — and the audit chain faithfully records the wrong answer.
 *
 * So: retry, validate with the schema rather than trusting the cast, and if every attempt misses,
 * throw. `reviewAction` turns that into a fail-CLOSED hold. Aborting into human review costs a
 * reviewer's attention; failing open costs the guarantee the governance layer exists to make.
 */
export async function judgeWithRetry(
  generate: JudgeGenerate, prompt: string, attempts = JUDGE_ATTEMPTS,
) {
  let last = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res: any = await generate(prompt);
    const parsed = ReviewerOutputSchema.safeParse(res?.object);
    if (parsed.success) return parsed.data;
    last = res?.object === undefined
      ? `empty structured output (finishReason=${res?.finishReason})`
      : parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    logger.warn('policy judge attempt produced no usable object', { attempt, attempts, reason: last });
  }
  throw new JudgeUnavailableError(last);
}

/** Render the retrieved policies into the prompt. Only these codes may be cited. */
export function buildJudgePrompt(action: string, policies: { policy_code: string; policy_text: string; severity: string }[]): string {
  const list = policies
    .map(p => `<policy code="${p.policy_code}" severity="${p.severity}">${p.policy_text}</policy>`)
    .join('\n');
  return `ACTION: ${action}\n\nRETRIEVED POLICIES:\n${list}\n\nReturn the violations.`;
}

/** Build an LLM-backed policy judge (a Mastra agent with structured output) for the reviewer. */
export function buildPolicyJudge(cfg: Config): PolicyJudge {
  const agent = new Agent({
    id: 'policy-judge', name: 'policy-judge',
    instructions: 'You are a compliance policy reviewer. Given a proposed action and the RETRIEVED policies, list every policy the action VIOLATES. You may ONLY cite policy codes that appear in the prompt. Return {violations:[{policy_code,severity,cited_text}]}.',
    model: getLLM(cfg),
  });
  const generate: JudgeGenerate = prompt => agent.generate(
    [{ role: 'user', content: prompt }],
    { structuredOutput: { schema: ReviewerOutputSchema }, temperature: 0 } as any,
  );
  return ({ action, policies }) => judgeWithRetry(generate, buildJudgePrompt(action, policies));
}
