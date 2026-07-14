import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { Config } from '../config';

const MAX_TOKENS: Record<string, number> = {
  'claude-opus-4-8': 8192,
  'claude-sonnet-5': 8192,
  'claude-haiku-4-5': 8192,
  'us.anthropic.claude-haiku-4-5-20251001-v1:0': 8192,
};

/** Models that reject an explicit temperature field entirely. */
const NO_TEMPERATURE = new Set(['claude-opus-4-8', 'claude-opus-4-7']);

export function maxTokensFor(model: string): number {
  return MAX_TOKENS[model] ?? 4096;
}

export function temperatureFor(model: string): number | undefined {
  return NO_TEMPERATURE.has(model) ? undefined : 0;
}

/** The @ai-sdk/anthropic client appends `/messages`; the base must be the API root (…/v1). */
function normalizeAnthropicBaseURL(url: string): string {
  return url.replace(/\/messages\/?$/, '');
}

export function getLLM(cfg: Config, modelOverride?: string): ReturnType<ReturnType<typeof createAnthropic>> {
  const model = modelOverride || cfg.llmModel;
  switch (cfg.llmProvider) {
    case 'anthropic': {
      const opts: Parameters<typeof createAnthropic>[0] = {};
      if (cfg.llmBaseUrl) opts.baseURL = normalizeAnthropicBaseURL(cfg.llmBaseUrl);
      if (cfg.llmGatewayApiKey) {
        opts.headers = { 'api-key': cfg.llmGatewayApiKey };
        opts.apiKey = cfg.llmGatewayApiKey;
      }
      return createAnthropic(opts)(model);
    }
    case 'openai':
      return createOpenAI(cfg.llmBaseUrl ? { baseURL: cfg.llmBaseUrl } : {})(model);
    case 'bedrock': {
      const opts: Parameters<typeof createAmazonBedrock>[0] = { credentialProvider: fromNodeProviderChain() };
      if (cfg.bedrockRegion) opts.region = cfg.bedrockRegion;
      if (cfg.llmBaseUrl) opts.baseURL = cfg.llmBaseUrl;
      return createAmazonBedrock(opts)(model);
    }
    default:
      throw new Error(`Unsupported LLM_PROVIDER: ${cfg.llmProvider}`);
  }
}
