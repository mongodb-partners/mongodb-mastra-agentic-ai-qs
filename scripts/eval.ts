import { MongoClient } from 'mongodb';
import { loadConfig } from '../src/config';
import { logger } from '../src/observability/logger';
import { getQueryEmbedder } from '../src/mastra/embed';
import { RetrievalService } from '../src/retrieval/service';
import { buildInvestigationAgent, runInvestigation } from '../src/mastra/investigation-agent';
import { triage, reconcile } from '../src/decision/core';
import { loadTransactionSeed, EXPECTED_DISPOSITION } from '../src/ingestion/transaction-fixtures';
import { scoreEval, type EvalCase } from '../src/eval/metrics';

// Fraud recall gate: missing a fraud case (letting it auto-approve) is the costly error.
const FRAUD_RECALL_MIN = 1.0;

async function main() {
  try { process.loadEnvFile(); } catch { /* .env optional */ }
  const cfg = loadConfig();
  const client = new MongoClient(cfg.mongoUri);
  await client.connect();
  const db = client.db(cfg.mongoDb);
  const emb = getQueryEmbedder(cfg);
  const svc = new RetrievalService(db, t => emb.embedQuery(t));
  const agent = buildInvestigationAgent(cfg, svc);

  // Eval over the LIVE review cases (one per lane), each labeled by expected disposition.
  const liveCases = loadTransactionSeed().filter(s => s.model_used === 'live');
  const results: EvalCase[] = [];
  for (const t of liveCases) {
    const verdict = await runInvestigation(agent, cfg, t.text);
    const ring = await svc.traceFunds(t.sender.account_number);
    const facts = {
      transaction_id: t.transaction_id, amount: t.amount, sender_account: t.sender.account_number,
      lane: t.lane, sanctions_hit: t.lane === 'sanctions', ring_suspicious: ring.suspicious_patterns,
    };
    const decision = triage(facts) ?? reconcile(facts, verdict);
    results.push({
      transaction_id: t.transaction_id, lane: t.lane,
      expected: EXPECTED_DISPOSITION[t.lane], actual: decision.disposition,
    });
    logger.info('eval case', { id: t.transaction_id, lane: t.lane, expected: EXPECTED_DISPOSITION[t.lane], actual: decision.disposition });
  }

  const report = scoreEval(results);
  logger.info('EVAL SCORECARD', {
    n: report.n, accuracy: report.accuracy, fraudRecall: report.fraudRecall,
    perClass: report.perClass.map(p => `${p.label} f1=${p.f1}`),
  });
  console.log(JSON.stringify(report, null, 2));

  await client.close();
  if (report.fraudRecall < FRAUD_RECALL_MIN) {
    logger.error('EVAL GATE FAILED', { fraudRecall: report.fraudRecall, min: FRAUD_RECALL_MIN });
    process.exit(1);
  }
  logger.info('EVAL GATE PASSED', { fraudRecall: report.fraudRecall });
}

main().then(() => process.exit(0)).catch(err => { logger.error('eval failed', { err: String(err) }); process.exit(1); });
