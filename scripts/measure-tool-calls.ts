import { MongoClient } from 'mongodb';
import { loadConfig } from '../src/config';
import { getQueryEmbedder } from '../src/mastra/embed';
import { RetrievalService } from '../src/retrieval/service';
import { createVectorStore } from '../src/retrieval/vector-store';
import { buildInvestigationAgent, runInvestigation } from '../src/mastra/investigation-agent';
import { ToolCallRecorder } from '../src/mastra/tool-recorder';
import { TRANSACTIONS_COLLECTION } from '../src/mastra/schemas/transactions';

/**
 * Measure how often the agent calls the SAME tool twice within one case.
 *
 * WHY THIS EXISTS. The console's ops panel renders one row per recorded tool call, keyed by tool
 * name and MongoDB operator and nothing else (public/app.js:460). A case that calls
 * `recall_verdicts` twice therefore shows two visually identical `$vectorSearch` rows, and the
 * observed duplicate pair returned the SAME five transaction ids — a redundant Atlas round-trip
 * with no new information. Whether that is worth a prompt change is an empirical question about
 * model behaviour, and model behaviour at temperature 0 is still not deterministic across runs (the
 * same case has been observed taking different tool trajectories minutes apart). So: run the queue
 * N times and count, rather than reasoning about one capture.
 *
 * WHY IT DOES NOT USE runPendingInvestigations. That function is the real pipeline and it WRITES —
 * `agent_events`, `case_analysis`, `reviews`, `audit_trail`, plus a status flip on each transaction.
 * Running it N times to answer a question about the model would fill the console's feed with N runs
 * of duplicate history and move every case out of `pending`, so the second iteration would find an
 * empty queue and silently measure nothing. This harness calls `runInvestigation` directly instead:
 * the agent and its tools only READ, and ToolCallRecorder is in-memory, so N iterations leave the
 * database exactly as they found it. It is a measurement, not a run.
 *
 * WHY IT MUST RUN ON THE BOX. Two independent reasons. The credential: the LLM key lives in SSM on
 * the deployed boxes, not in a laptop `.env`. The measurement: a laptop's WAN leg to Atlas is ~250ms
 * and has been measured to invert latency conclusions, so any `ms` collected off-box is not a number
 * to publish. This harness reports timings only as context for the duplicate counts — the counts
 * themselves are laptop-safe, the timings are not.
 *
 *   docker compose exec -T app pnpm tsx scripts/measure-tool-calls.ts 5 [model-id]
 *
 * Reads MONGODB_DB from the environment like everything else. Point it at a corpus that HAS pending
 * review cases — `marshal` carries the six `txn-review-*` cases. It never writes, so it is safe to
 * run against the database the console is serving.
 *
 * The optional model id overrides LLM_MODEL for the run, so the same queue can be measured across
 * models without touching the box's environment or restarting the container. It goes through the same
 * `modelOverride` parameter the eval and bench scripts already use, so the model under test is
 * configured exactly as production would configure it.
 */

/** Default iterations. Enough to distinguish "always" from "sometimes"; override with argv[2]. */
const DEFAULT_RUNS = 5;

interface CaseResult {
  transaction_id: string;
  /** Tool names in call order, so a trajectory can be compared across runs verbatim. */
  sequence: string[];
  /** Tool name -> times called in this case. Only entries >1 are duplicates. */
  counts: Map<string, number>;
  /**
   * For each duplicated tool: whether every call returned the SAME result summary.
   *
   * This is the distinction that decides whether a duplicate is waste or work. Two calls with
   * different queries that return different precedents are the agent following up on what it
   * learned; two that return an identical id list are a redundant round-trip. The recorder's
   * `detail` is the first four transaction ids (tool-recorder.ts:100-107), which is exactly the
   * comparison key we want and is already truncated to a bounded length.
   */
  redundant: { tool: string; calls: number; identicalResults: boolean; queries: string[] }[];
  /**
   * Wall-clock for the whole investigation, INCLUDING any retried verdict attempt.
   *
   * This is the number the stage cares about: the model window is the demo's longest visible gap, and
   * a model that duplicates less but thinks longer is not obviously a win. Measured on the box, so the
   * Atlas leg is the real one — the same measurement from a laptop carries a ~250ms WAN penalty per
   * tool call and has been shown to invert conclusions.
   */
  ms: number;
  /** Present when the case threw — a failed case must be visible, not averaged away as a zero. */
  error?: string;
}

/** Group a case's recorded calls by tool name, preserving call order within each group. */
function byTool(events: { tool: { name: string; args: Record<string, unknown> }; detail?: string }[]) {
  const groups = new Map<string, { detail?: string; query: string }[]>();
  for (const e of events) {
    const list = groups.get(e.tool.name) ?? [];
    list.push({ detail: e.detail, query: String(e.tool.args.query ?? '') });
    groups.set(e.tool.name, list);
  }
  return groups;
}

async function investigateOnce(
  agent: ReturnType<typeof buildInvestigationAgent>,
  cfg: ReturnType<typeof loadConfig>,
  narrative: string,
  transaction_id: string,
  modelOverride?: string,
  subject?: { transaction_id?: string; sender_account?: string; recipient_account?: string },
): Promise<CaseResult> {
  const recorder = new ToolCallRecorder();
  const t0 = Date.now();
  try {
    await runInvestigation(agent, cfg, narrative, modelOverride, recorder, subject);
  } catch (err) {
    // A case that never produced a valid verdict still made tool calls, but they were never
    // committed, so there is nothing honest to count. Report it rather than folding it into the
    // duplicate rate as a clean run.
    return { transaction_id, sequence: [], counts: new Map(), redundant: [], ms: Date.now() - t0, error: String(err) };
  }
  const ms = Date.now() - t0;
  const events = recorder.drain();
  const groups = byTool(events);
  const counts = new Map([...groups].map(([name, calls]) => [name, calls.length]));
  const redundant = [...groups]
    .filter(([, calls]) => calls.length > 1)
    .map(([tool, calls]) => ({
      tool,
      calls: calls.length,
      identicalResults: new Set(calls.map(c => c.detail ?? '')).size === 1,
      queries: calls.map(c => c.query),
    }));
  return { transaction_id, sequence: events.map(e => e.tool.name), counts, redundant, ms };
}

async function main() {
  try { process.loadEnvFile(); } catch { /* .env optional — on the box the env is already populated */ }
  const runs = Number(process.argv[2] ?? DEFAULT_RUNS);
  if (!Number.isInteger(runs) || runs < 1) {
    console.error(`usage: tsx scripts/measure-tool-calls.ts [runs] [model-id]  (got "${process.argv[2]}")`);
    process.exit(2);
  }
  const modelOverride = process.argv[3];
  const cfg = loadConfig();

  const client = new MongoClient(cfg.mongoUri);
  await client.connect();
  const db = client.db(cfg.mongoDb);

  // Same selection as the real pipeline (run-engine.ts:71-73) so the trajectories are comparable to
  // what the console shows, including the sort — case ORDER cannot matter here (each case is an
  // independent generate() call with no carried conversation) but matching it removes one difference.
  const pending = await db.collection(TRANSACTIONS_COLLECTION)
    .find({ status: 'pending' }, { projection: { embedding: 0 } })
    .sort({ amount: -1 }).toArray();

  if (!pending.length) {
    console.error(`no pending transactions in ${cfg.mongoDb} — nothing to measure. (Did a live run already decide them?)`);
    await client.close();
    process.exit(1);
  }

  const emb = getQueryEmbedder(cfg);
  // Constructed AFTER the empty-queue exit above, so the early exit needs no disconnect: the store
  // opens its own MongoClient (the library bundles its own driver) and this harness holds one for the
  // whole measurement rather than per run, matching how run-engine.ts scopes it to a run.
  const store = await createVectorStore(cfg, 'marshal-measure');
  const svc = new RetrievalService(db, store, t => emb.embedQuery(t));
  const agent = buildInvestigationAgent(cfg, svc, modelOverride);

  console.log(`model=${modelOverride ?? cfg.llmModel}${modelOverride ? ' (override)' : ''} provider=${cfg.llmProvider} db=${cfg.mongoDb} cases=${pending.length} runs=${runs}`);
  console.log(`NOTE: read-only — no events, analyses or verdicts are written.\n`);

  const all: CaseResult[] = [];
  for (let run = 1; run <= runs; run++) {
    for (const t of pending as any[]) {
      // The hard-compliance lane never reaches the agent at all (run-engine.ts:100-117 rejects a
      // sanctions hit deterministically, before any LLM call), so including it would report a
      // permanent zero-tool case and understate the duplicate rate across the queue.
      if (t.lane === 'sanctions') continue;
      // Pass the subject exactly as run-engine.ts does, or this measures an agent the app no longer
      // runs — the whole point of the change under test is that the account is given, not guessed.
      const r = await investigateOnce(agent, cfg, t.text, t.transaction_id, modelOverride, {
        transaction_id: t.transaction_id,
        sender_account: t.sender?.account_number,
        recipient_account: t.recipient?.account_number,
      });
      all.push(r);
      const dup = r.redundant.length
        ? r.redundant.map(d => `${d.tool}×${d.calls}${d.identicalResults ? ' SAME-RESULTS' : ' different'}`).join(', ')
        : '—';
      console.log(`run ${run} ${r.transaction_id.padEnd(22)} ${String(r.sequence.length).padStart(2)} calls ${String((r.ms / 1000).toFixed(1)).padStart(5)}s  dup: ${dup}${r.error ? `  ERROR: ${r.error.slice(0, 80)}` : ''}`);
    }
  }

  // ---- Summary -------------------------------------------------------------------------------
  const usable = all.filter(r => !r.error);
  const failed = all.length - usable.length;
  const withDup = usable.filter(r => r.redundant.length > 0);
  const identical = withDup.filter(r => r.redundant.some(d => d.identicalResults));

  console.log(`\n=== ${usable.length} usable case-runs${failed ? `, ${failed} FAILED (excluded)` : ''} ===`);
  console.log(`case-runs with a duplicated tool: ${withDup.length}/${usable.length} (${pct(withDup.length, usable.length)})`);
  console.log(`  ...of which returned IDENTICAL results: ${identical.length} (the redundant ones)`);

  // Median, not mean: n is small and one retried verdict attempt doubles a case's wall-clock, which
  // would drag a mean somewhere no individual run actually sat.
  const times = usable.map(r => r.ms).sort((a, b) => a - b);
  const calls = usable.map(r => r.sequence.length).sort((a, b) => a - b);
  const med = (xs: number[]) => xs.length === 0 ? 0
    : xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2;
  if (times.length) {
    console.log(`case wall-clock: median ${(med(times) / 1000).toFixed(1)}s  min ${(times[0] / 1000).toFixed(1)}s  max ${(times[times.length - 1] / 1000).toFixed(1)}s`);
    console.log(`tool calls per case: median ${med(calls)}  min ${calls[0]}  max ${calls[calls.length - 1]}`);
  }
  if (failed) console.log(`FAILED case-runs: ${failed} — a model that cannot produce a valid verdict is a demo risk, not a rounding error.`);

  // Per-tool duplicate rate: which tool the model actually reasks, not just that it reasks.
  const perTool = new Map<string, { dupRuns: number; sameResults: number }>();
  for (const r of usable) {
    for (const d of r.redundant) {
      const e = perTool.get(d.tool) ?? { dupRuns: 0, sameResults: 0 };
      e.dupRuns++;
      if (d.identicalResults) e.sameResults++;
      perTool.set(d.tool, e);
    }
  }
  if (perTool.size) {
    console.log(`\nduplicated tools:`);
    for (const [tool, e] of [...perTool].sort((a, b) => b[1].dupRuns - a[1].dupRuns)) {
      console.log(`  ${tool.padEnd(18)} duplicated in ${e.dupRuns} case-run(s), identical results in ${e.sameResults}`);
    }
  }

  // Per-case trajectory stability. A case whose sequence differs across runs is one a presenter
  // cannot rehearse — worth knowing independently of duplicates.
  console.log(`\nper-case trajectory stability:`);
  const cases = [...new Set(usable.map(r => r.transaction_id))];
  for (const id of cases) {
    const seqs = usable.filter(r => r.transaction_id === id).map(r => r.sequence.join('→'));
    const distinct = new Set(seqs);
    const dupRate = usable.filter(r => r.transaction_id === id && r.redundant.length).length;
    console.log(`  ${id.padEnd(22)} ${distinct.size} distinct trajector${distinct.size === 1 ? 'y' : 'ies'} in ${seqs.length} runs, ${dupRate} with duplicates`);
    if (distinct.size > 1) for (const s of distinct) console.log(`      ${s}`);
  }

  // The queries behind identical-result duplicates: the evidence for whether a prompt change is the
  // right fix. Near-synonymous strings mean the model reworded rather than followed up.
  const examples = identical.flatMap(r => r.redundant.filter(d => d.identicalResults).map(d => ({ id: r.transaction_id, ...d })));
  if (examples.length) {
    console.log(`\nredundant queries (same results, different wording):`);
    for (const e of examples.slice(0, 8)) {
      console.log(`  ${e.id} ${e.tool}:`);
      for (const q of e.queries) console.log(`      "${q}"`);
    }
    if (examples.length > 8) console.log(`  ... and ${examples.length - 8} more`);
  }

  await store.disconnect();
  await client.close();
}

function pct(a: number, b: number): string {
  return b === 0 ? 'n/a' : `${((a / b) * 100).toFixed(0)}%`;
}

main().then(() => process.exit(0)).catch(err => { console.error(String(err)); process.exit(1); });
