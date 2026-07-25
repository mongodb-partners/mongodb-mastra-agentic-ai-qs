import { z } from 'zod';

export interface Config {
  appName: string;
  mongoUri: string;
  mongoDb: string;
  voyageApiKey: string;
  voyageBaseUrl?: string;
  llmProvider: 'anthropic' | 'openai' | 'bedrock';
  llmModel: string;
  llmBaseUrl?: string;
  llmGatewayApiKey?: string;
  bedrockRegion?: string;
  port: number;
  rrfK: number;
  /** HMAC secret for the append-only audit chain. Host-side only; never stored in records. */
  auditSecret: string;
  /** SEPARATE HMAC secret for signing/verifying session tokens (not reused for the audit chain). */
  sessionSecret: string;
  /**
   * Demo mode. false (default) = prod quickstart: Launch runs the live Mastra agent + real LLM.
   * true = demo: Launch REPLAYS a pre-baked recorded run (case_analysis + agent_events)
   * with no runtime LLM — deterministic, instant, free, scales to any number of viewers.
   */
  demoMode: boolean;
  /**
   * Size of the synthetic decided-precedent corpus seeded at provision time (the "deployment at
   * scale" story: hybrid/vector/graph retrieval runs over this many real, embedded documents).
   * 0 disables synthetic seeding (curated seed cases only).
   */
  seedScaleCount: number;
  /**
   * UI layout mode. '' (default) = the responsive layout picks a tier from the viewport.
   * 'classic' = pin the pre-2026-07-25 fixed three-column stage layout at every width, for every
   * visitor. The mid-demo escape hatch is the ?ui=classic query param, which needs no restart;
   * this env var is the fleet-wide default.
   */
  uiMode: string;
  /**
   * Default on-screen copy density: '' (auto from viewport) | 'full' | 'lean' | 'minimal'.
   * ?density= overrides it per visitor.
   */
  uiDensity: string;
}

const EnvSchema = z.object({
  APP_NAME: z.string().min(1).default('Marshal'),
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  MONGODB_DB: z.string().min(1).default('marshal'),
  VOYAGE_API_KEY: z.string().min(1, 'VOYAGE_API_KEY is required'),
  VOYAGE_BASE_URL: z.string().optional(),
  LLM_PROVIDER: z.enum(['anthropic', 'openai', 'bedrock']).default('anthropic'),
  LLM_MODEL: z.string().min(1).default('claude-haiku-4-5'),
  LLM_BASE_URL: z.string().optional(),
  // Gateway key sent as the `api-key` header when LLM_BASE_URL points at an APIM gateway.
  GROVE_API_KEY: z.string().optional(),
  BEDROCK_REGION: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(8000),
  RRF_K: z.coerce.number().int().positive().default(60),
  // Secrets: no schema default. A dev fallback is applied in loadConfig ONLY for non-production /
  // demo runs; production with a live agent must set real secrets or startup fails (see below).
  AUDIT_SECRET: z.string().optional(),
  SESSION_SECRET: z.string().optional(),
  NODE_ENV: z.string().optional(),
  DEMO_MODE: z.string().optional(),
  SEED_SCALE_COUNT: z.coerce.number().int().min(0).default(1200),
  MARSHAL_UI: z.enum(['classic', 'auto', '']).default(''),
  MARSHAL_DENSITY: z.enum(['full', 'lean', 'minimal', '']).default(''),
});

/**
 * Exported because the committed replay audit chain is signed with it (baking runs locally, where
 * AUDIT_SECRET is usually unset), so `pnpm restore:replay` needs it as the "old" key when re-signing
 * the chain for a box that sets a real secret. Never a valid production audit key.
 */
export const DEV_AUDIT_SECRET = 'marshal-dev-audit-secret';
const DEV_SESSION_SECRET = 'marshal-dev-session-secret';

export function loadConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Config {
  const e = EnvSchema.parse(env);
  const demoMode = (e.DEMO_MODE ?? '').toLowerCase() === 'true' || e.DEMO_MODE === '1';
  // Fail fast: a production deployment running the LIVE agent must supply real secrets — never
  // ship the forgeable dev defaults for the audit chain or session tokens. Demo/non-prod may
  // fall back to dev secrets for convenience.
  const isProd = (e.NODE_ENV ?? '').toLowerCase() === 'production';
  if (isProd && !demoMode) {
    if (!e.AUDIT_SECRET) throw new Error('AUDIT_SECRET must be set in production (no default).');
    if (!e.SESSION_SECRET) throw new Error('SESSION_SECRET must be set in production (no default).');
  }
  const auditSecret = e.AUDIT_SECRET ?? DEV_AUDIT_SECRET;
  // Session secret defaults to its own dev value — and, importantly, is NEVER the audit secret,
  // so a leaked/guessed audit secret can't forge session tokens (and vice-versa).
  const sessionSecret = e.SESSION_SECRET ?? DEV_SESSION_SECRET;
  return {
    appName: e.APP_NAME,
    mongoUri: e.MONGODB_URI,
    mongoDb: e.MONGODB_DB,
    voyageApiKey: e.VOYAGE_API_KEY,
    voyageBaseUrl: e.VOYAGE_BASE_URL,
    llmProvider: e.LLM_PROVIDER,
    llmModel: e.LLM_MODEL,
    llmBaseUrl: e.LLM_BASE_URL,
    llmGatewayApiKey: e.GROVE_API_KEY,
    bedrockRegion: e.BEDROCK_REGION,
    port: e.PORT,
    rrfK: e.RRF_K,
    auditSecret,
    sessionSecret,
    demoMode,
    seedScaleCount: e.SEED_SCALE_COUNT,
    // 'auto' is the schema-valid way to say "no override", and normalises to '' so the client
    // sees one shape for both.
    uiMode: e.MARSHAL_UI === 'auto' ? '' : e.MARSHAL_UI,
    uiDensity: e.MARSHAL_DENSITY,
  };
}
