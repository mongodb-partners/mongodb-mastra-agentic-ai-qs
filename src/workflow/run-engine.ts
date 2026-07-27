import type { Db } from 'mongodb';
import type { Config } from '../config';
import { RetrievalService } from '../retrieval/service';
import { buildInvestigationAgent, runInvestigation } from '../mastra/investigation-agent';
import { reviewAction } from '../governance/reviewer';
import { buildPolicyJudge } from '../governance/judge';
import { runCaseInvestigation } from './investigate';
import { evidenceHash, type EvidenceSnapshot } from './evidence';
import { formatMoney, moneyToNumber } from '../money';
import { triage, reconcile } from '../decision/core';
import { getQueryEmbedder } from '../mastra/embed';
import { TRANSACTIONS_COLLECTION } from '../mastra/schemas/transactions';
import { logger } from '../observability/logger';
import { ToolCallRecorder, type ToolCallEvent } from '../mastra/tool-recorder';

export const AGENT_EVENTS_COLLECTION = 'agent_events';
export const CASE_ANALYSIS_COLLECTION = 'case_analysis';

/** The MongoDB capabilities each investigation exercises — surfaced to the UI capability rail. */
export type Capability = 'vector' | 'fulltext' | 'hybrid' | 'graph' | 'memory' | 'governance' | 'durable' | 'audit';

async function emit(db: Db, e: { transaction_id: string; step: string; headline: string; detail?: string; capabilities?: Capability[]; run_id?: string }) {
  // `capabilities` is the set of MongoDB jobs this step exercised (an event can hit several —
  // hybrid search runs vector + full-text + fusion). The rail counts across this array.
  await db.collection(AGENT_EVENTS_COLLECTION).insertOne({ ...e, capability: e.capabilities?.[0], ts: new Date() });
}

/**
 * Shape one recorded tool call into an `agent_events` document.
 *
 * Deliberately NOT routed through emit(): emit() stamps `ts: new Date()`, which is write time, and
 * these events are written as a batch after the verdict returns. Their recorded `ts` is the real
 * completion instant, and the replay paces off `ts` deltas — overwriting it would collapse every
 * tool call in a case into one frame.
 */
export function toolEventDoc(run_id: string, transaction_id: string, e: ToolCallEvent) {
  const cap = e.capabilities?.[0];
  return {
    run_id, transaction_id,
    step: e.step, headline: e.headline, detail: e.detail,
    ...(e.capabilities ? { capabilities: e.capabilities } : {}),
    ...(cap ? { capability: cap } : {}),
    tool: e.tool,
    ts: e.ts,
  };
}

/**
 * Tag for the batch of events one `runPendingInvestigations` call produces. `agent_events` is only
 * cleared by a reset, so without this the same case investigated in two runs is indistinguishable
 * from one very slow case — which is exactly how `latency_p50_ms` came to report 290 s for cases
 * that took 7 s (see caseSpansMs in server/stats.ts). Wall-clock + a random suffix, because two
 * runs can start inside the same millisecond and the value only needs to be distinct, not ordered.
 */
function newRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Investigate every PENDING transaction with the real pipeline, one at a time, emitting a step
 * event at each stage AND persisting a rich case_analysis document (precedents, ring graph,
 * policies, verdict, decision, capabilities exercised) so the UI's case-detail view is a pure
 * projection of stored data.
 */
export async function runPendingInvestigations(db: Db, cfg: Config): Promise<{ investigated: number; run_id: string }> {
  const emb = getQueryEmbedder(cfg);
  const svc = new RetrievalService(db, t => emb.embedQuery(t));
  const agent = buildInvestigationAgent(cfg, svc);
  const judge = buildPolicyJudge(cfg);

  const pending = await db.collection(TRANSACTIONS_COLLECTION)
    .find({ status: 'pending' }, { projection: { embedding: 0 } })
    .sort({ amount: -1 }).toArray();

  // Stamped on every event this run emits so per-case latency can tell "investigated twice" from
  // "took nine minutes". Bind it once here, not per case.
  const run_id = newRunId();
  logger.info('investigation run starting', { run_id, pending: pending.length });

  let n = 0;
  for (const t of pending as any[]) {
    const id = t.transaction_id;

    // PER-CASE ISOLATION: one bad case must not abandon the rest of the queue. Anything that can
    // throw here is per-transaction (a model call that never yields a valid verdict, a tool error,
    // a single failed write), so a run over 50 pending transactions used to stop at the first one
    // and leave the remainder silently untouched. Record the failure as a visible step event and
    // move on; `investigated` counts only the cases that actually completed.
    try {
      const caps = new Set<Capability>();
      const facts0 = { transaction_id: id, amount: t.amount, sender_account: t.sender.account_number, lane: t.lane, sanctions_hit: t.lane === 'sanctions', ring_suspicious: false };
      // formatMoney, not t.amount.toLocaleString(): Decimal128 HAS a toLocaleString, and it
      // returns a bare "4950.00" with no thousands separator — so this reads as a formatting
      // regression in the demo's first visible line rather than as an error.
      await emit(db, { run_id, transaction_id: id, step: 'triage', headline: `Investigating ${id}`, detail: `$${formatMoney(t.amount)} · ${t.lane}` });

      // HARD-COMPLIANCE GATE, BEFORE any LLM. A sanctions/watchlist hit is a deterministic reject —
      // the agent and policy judge are never consulted (no tokens, no chance of an LLM overriding a
      // hard reject). This mirrors decision/core.triage() and must run first (review finding #1).
      const hard = triage(facts0);
      if (hard) {
        caps.add('durable'); caps.add('audit');
        await emit(db, { run_id, transaction_id: id, step: 'govern', headline: `Hard compliance: ${hard.risk_factors[0]}`, detail: 'deterministic reject — agent not consulted', capabilities: ['governance'] });
        const now0 = new Date().toISOString();
        await runCaseInvestigation(db, cfg.auditSecret, facts0, { recommendation: 'reject', confidence: 100, risk_factors: hard.risk_factors, rationale: hard.rationale }, 0, false, now0);
        await db.collection(CASE_ANALYSIS_COLLECTION).replaceOne({ transaction_id: id }, {
          transaction_id: id, amount: t.amount, lane: t.lane, sender: t.sender, recipient: t.recipient, narrative: t.text,
          precedents: [], memory: [], ring: { edges: [] }, governance: { compliance_score: 0, violations: [], held: false, dropped_citations: [] },
          verdict: { recommendation: 'reject', confidence: 100, risk_factors: hard.risk_factors, rationale: hard.rationale },
          tool_calls: [],
          decision: { disposition: hard.disposition, decided_by: hard.decided_by, risk_factors: hard.risk_factors, rationale: hard.rationale },
          phase: 'committed', capabilities: [...caps], updated_at: new Date(),
        }, { upsert: true });
        await emit(db, { run_id, transaction_id: id, step: 'commit', capabilities: ['durable', 'audit'], headline: `Auto-reject (compliance)`, detail: 'reject' });
        n++;
        continue;
      }

      // Retrieval (hybrid = vector + full-text fused server-side by $rankFusion).
      const precedents = await svc.hybrid(t.text, 4);
      caps.add('hybrid'); caps.add('vector'); caps.add('fulltext');
      await emit(db, { run_id, transaction_id: id, step: 'retrieve', headline: `${precedents.length} precedents (hybrid search)`, detail: precedents.map(p => p.transaction_id).join(', '), capabilities: ['hybrid', 'vector', 'fulltext'] });

      // Memory recall (cite prior verdicts).
      const memory = precedents.slice(0, 2).map(p => ({ transaction_id: p.transaction_id, disposition: p.status, lane: p.lane }));
      if (memory.length) {
        caps.add('memory');
        await emit(db, { run_id, transaction_id: id, step: 'recall', headline: `Recalled ${memory.length} prior verdict(s)`, detail: memory.map(m => `${m.transaction_id}→${m.disposition}`).join(', '), capabilities: ['memory'] });
      }

      // Agent reasoning. The recorder turns each of the agent's own tool calls into a timeline
      // event, so the model's thinking window shows the Atlas operations happening inside it
      // instead of reading as one dead gap. Fresh per case: drain() is called right below, but a
      // per-case instance also means a case that throws cannot leak its calls into the next one.
      const recorder = new ToolCallRecorder();
      const verdict = await runInvestigation(agent, cfg, t.text, undefined, recorder);

      // Tool events go in BEFORE the reason event and in call order — they are how the verdict was
      // reached, and in live mode the change stream delivers them in insertion order.
      const toolEvents = recorder.drain();
      for (const te of toolEvents) {
        te.capabilities?.forEach(c => caps.add(c));
        await db.collection(AGENT_EVENTS_COLLECTION).insertOne(toolEventDoc(run_id, id, te));
      }
      await emit(db, { run_id, transaction_id: id, step: 'reason', headline: `Agent: ${verdict.recommendation} · confidence ${verdict.confidence}`, detail: verdict.risk_factors[0] });

      // Graph fund-tracing ($graphLookup) runs on every case — emit either way so the rail reflects it.
      const ring = await svc.traceFundsGraph(t.sender.account_number);
      caps.add('graph');
      await emit(db, {
        run_id, transaction_id: id, step: 'graph', capabilities: ['graph'],
        headline: ring.suspicious_patterns ? `Ring detected · ${ring.network_size} hops` : `Fund-trace clean`,
        detail: ring.suspicious_patterns ? `circular_flow=${ring.circular_flow} layering=${ring.layering}` : `network_size=${ring.network_size}`,
      });

      // Governance review.
      const gov = await reviewAction(db, x => emb.embedQuery(x), judge, `Disposition ${verdict.recommendation} for ${id}: ${t.text}`);
      caps.add('governance');
      await emit(db, { run_id, transaction_id: id, step: 'govern', headline: `Policy score ${gov.compliance_score}${gov.held ? ' · HELD' : ''}`, detail: gov.violations.map(v => v.policy_code).join(', '), capabilities: ['governance'] });

      // Deterministic decision + durable gate.
      const facts = { transaction_id: id, amount: t.amount, sender_account: t.sender.account_number, lane: t.lane, sanctions_hit: t.lane === 'sanctions', ring_suspicious: ring.suspicious_patterns };
      const decision = triage(facts) ?? reconcile(facts, verdict);
      const now = new Date().toISOString();
      const snapshot: EvidenceSnapshot = {
        transaction_id: id, proposed_disposition: decision.disposition, amount: moneyToNumber(t.amount),
        risk_factors: decision.risk_factors, compliance_score: gov.compliance_score,
      };
      const out = await runCaseInvestigation(db, cfg.auditSecret, facts, verdict, gov.compliance_score, gov.held, now);
      caps.add('durable'); caps.add('audit');

      // Persist the full analysis for the case-detail view (projection of stored data).
      await db.collection(CASE_ANALYSIS_COLLECTION).replaceOne({ transaction_id: id }, {
        transaction_id: id, amount: t.amount, lane: t.lane,
        sender: t.sender, recipient: t.recipient, narrative: t.text,
        precedents, memory, ring, governance: gov, verdict,
        tool_calls: toolEvents.map(te => te.tool),
        decision: { disposition: decision.disposition, decided_by: decision.decided_by, risk_factors: decision.risk_factors, rationale: decision.rationale },
        phase: out.phase, evidence_hash: out.evidence_hash ?? evidenceHash(snapshot),
        snapshot, capabilities: [...caps], updated_at: new Date(),
      }, { upsert: true });

      await emit(db, {
        run_id, transaction_id: id, step: out.phase === 'suspended' ? 'suspend' : 'commit',
        capabilities: ['durable', 'audit'],
        headline: out.phase === 'suspended' ? `HELD for human review` : `Auto-${out.decision.disposition}`,
        detail: out.decision.disposition,
      });
      n++;
    } catch (err) {
      logger.error('investigation failed for transaction', { transaction_id: id, err: String(err) });
      await emit(db, { run_id, transaction_id: id, step: 'error', headline: 'Investigation failed', detail: String(err) })
        .catch(() => { /* the queue continues even if we cannot record why */ });
    }
  }
  return { investigated: n, run_id };
}
