import { logger } from '../observability/logger';
import type { Capability } from '../workflow/run-engine';

/**
 * The tool → MongoDB operator map. This pair IS the "better together" claim of the demo, carried
 * as data rather than asserted in copy: every tool the agent calls names the Atlas operator that
 * served it. Keys are the Mastra tool ids from src/mastra/tools/retrieval-tools.ts.
 */
export const TOOL_OPERATORS: Record<string, { op: string; capabilities: Capability[] }> = {
  hybrid_search: { op: '$rankFusion', capabilities: ['hybrid', 'vector', 'fulltext'] },
  search_precedent: { op: '$vectorSearch', capabilities: ['vector'] },
  search_text: { op: '$search', capabilities: ['fulltext'] },
  trace_funds: { op: '$graphLookup', capabilities: ['graph'] },
  recall_verdicts: { op: '$vectorSearch', capabilities: ['memory'] },
};

/**
 * Case narratives run to several hundred characters, and tool args land in a feed row AND in the
 * committed data/replay/*.json artifact. Cap at build time so the recording stays small — never at
 * render time, which would ship the full text and only hide it.
 */
export const MAX_ARG_QUERY_CHARS = 120;

/** One recorded tool call, shaped to drop straight into `agent_events` via run-engine's emit(). */
export interface ToolCallEvent {
  step: 'tool';
  headline: string;
  detail?: string;
  capabilities?: Capability[];
  /**
   * The instant this call COMPLETED, captured in the hook rather than at write time. The whole
   * batch is written after the verdict returns, so a write-time timestamp would put every tool call
   * inside the same millisecond — and the replay paces off recorded `ts` deltas, so they would all
   * collapse into a single frame and the model window would stay one dead gap.
   */
  ts: Date;
  tool: {
    name: string;
    op: string | null;
    ms: number;
    ok: boolean;
    args: Record<string, unknown>;
    result_count: number | null;
  };
}

/** Trim every string arg to the cap, and drop anything that is not a scalar we want in the record. */
function sanitizeArgs(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v.slice(0, MAX_ARG_QUERY_CHARS);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    // objects/arrays are dropped: no tool takes one, and an unbounded nested value is exactly what
    // the truncation above exists to prevent.
  }
  return out;
}

/** How many things did this tool find? Shape differs per tool, so probe rather than assume. */
function resultCount(output: unknown): number | null {
  if (!output || typeof output !== 'object') return null;
  const o = output as Record<string, unknown>;
  if (Array.isArray(o.results)) return o.results.length;
  if (Array.isArray(o.recalled)) return o.recalled.length;
  if (typeof o.network_size === 'number') return o.network_size;
  return null;
}

/** The unit `result_count` is counting, for the headline. */
function resultNoun(toolName: string): string {
  return toolName === 'trace_funds' ? 'hops' : 'results';
}

/** A one-line summary of what came back, for the feed's detail row. */
function summarize(toolName: string, output: unknown): string | undefined {
  if (!output || typeof output !== 'object') return undefined;
  const o = output as Record<string, unknown>;
  const rows = (Array.isArray(o.results) ? o.results : Array.isArray(o.recalled) ? o.recalled : null) as any[] | null;
  if (rows) {
    const ids = rows.map(r => r?.transaction_id).filter(Boolean).slice(0, 4);
    return ids.length ? ids.join(', ') : undefined;
  }
  if (typeof o.network_size === 'number') {
    return `circular_flow=${!!o.circular_flow} layering=${!!o.layering}`;
  }
  return undefined;
}

/**
 * Buffers one event per Mastra tool call, per verdict attempt.
 *
 * WHY PER-ATTEMPT. runInvestigation retries up to VERDICT_ATTEMPTS times because Bedrock
 * occasionally ends a structured-output turn with an empty object. Those retried turns really did
 * call tools against Atlas, but they belong to a discarded reasoning pass — writing them to
 * `agent_events` would put two contradictory sets of tool calls in the same case's permanent
 * timeline and inflate the capability rail with work no verdict rests on. So each attempt fills a
 * scratch buffer that only `commitAttempt()` promotes.
 *
 * WHY NO I/O IN THE HOOKS. @mastra/core awaits both hooks inline around each tool's execute, so
 * anything slow here is added to the agent's critical path on every call. The recorder is pure
 * in-memory; run-engine.ts does the writing after the verdict is in hand.
 */
export class ToolCallRecorder {
  private attempt: ToolCallEvent[] = [];
  private committed: ToolCallEvent[] = [];
  private started = new Map<string, number>();

  /** Begin a verdict attempt. Anything the previous, uncommitted attempt recorded is discarded. */
  startAttempt(): void {
    this.attempt = [];
    this.started.clear();
  }

  /** Promote this attempt's calls to the permanent record. Called only when a verdict validated. */
  commitAttempt(): void {
    this.committed.push(...this.attempt);
    this.attempt = [];
  }

  /** Take the committed events and reset, so the next case starts empty. */
  drain(): ToolCallEvent[] {
    const out = this.committed;
    this.committed = [];
    return out;
  }

  /** The ToolHooks object to pass as `hooks` on a per-execution generate() call. */
  hooks() {
    return {
      beforeToolCall: (ctx: any) => {
        this.started.set(String(ctx?.toolName ?? ''), Date.now());
      },
      afterToolCall: (ctx: any) => {
        const name = String(ctx?.toolName ?? 'unknown');
        const at = this.started.get(name);
        this.started.delete(name);
        const map = TOOL_OPERATORS[name];
        // An unmapped tool must degrade to an unlabelled row, never take down the run: losing a
        // whole investigation to a missing map entry is a far worse failure than a missing operator.
        if (!map) logger.warn('tool call has no MongoDB operator mapping', { tool: name });

        const ok = ctx?.error === undefined || ctx?.error === null;
        const count = ok ? resultCount(ctx?.output) : null;
        const done = Date.now();
        this.attempt.push({
          step: 'tool',
          headline: ok
            ? `${name} → ${count === null ? 'ok' : `${count} ${resultNoun(name)}`}`
            : `${name} → failed`,
          detail: ok ? summarize(name, ctx?.output) : String(ctx?.error),
          ...(map ? { capabilities: map.capabilities } : {}),
          ts: new Date(done),
          tool: {
            name,
            op: map?.op ?? null,
            ms: at === undefined ? 0 : Math.max(0, done - at),
            ok,
            args: sanitizeArgs(ctx?.input),
            result_count: count,
          },
        });
      },
    };
  }
}
