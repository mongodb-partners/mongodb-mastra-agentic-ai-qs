import { MongoClient } from 'mongodb';
import { loadConfig } from '../src/config';
import { logger } from '../src/observability/logger';
import { runPendingInvestigations } from '../src/workflow/run-engine';
import { loadTransactionSeed } from '../src/ingestion/transaction-fixtures';
import { snapshotReplay } from '../src/data/replay-store';

/**
 * Bake the deterministic demo replay: run the REAL agent pipeline once over every live case, then
 * snapshot the recorded run into immutable `replay_*` collections. DEMO_MODE reads ONLY those, so a
 * later live run or reset can never corrupt the recording (the two modes share one cluster safely).
 *
 * Run this once at seed time (after `pnpm provision`), on the operator's machine / CI — not per
 * user. Idempotent: it resets prior run state, restores cases to pending, investigates, snapshots.
 */
async function main() {
  try { process.loadEnvFile(); } catch { /* .env optional */ }
  const cfg = loadConfig();
  const client = new MongoClient(cfg.mongoUri);
  await client.connect();
  const db: any = client.db(cfg.mongoDb);
  db.client = client;

  // Clean prior run state and restore every seed transaction to its seed status.
  for (const n of ['cases', 'case_decisions', 'reviews', 'audit_trail', 'agent_events', 'case_analysis']) {
    await db.collection(n).deleteMany({});
  }
  const seed = loadTransactionSeed();
  for (const s of seed) {
    await db.collection('transactions').updateOne({ transaction_id: s.transaction_id }, { $set: { status: s.status } });
  }

  logger.info('baking replay — running the real agent over all pending cases (one-time)…');
  const { investigated } = await runPendingInvestigations(db, cfg);
  const events = await db.collection('agent_events').countDocuments();
  const analyses = await db.collection('case_analysis').countDocuments();
  logger.info('bake complete', { investigated, agent_events: events, case_analysis: analyses });

  // Freeze the recording into the immutable replay copies demo mode reads from.
  const snapshot = await snapshotReplay(db);
  logger.info('replay snapshot written (demo mode reads these; live runs never touch them)', snapshot);

  await client.close();
}

main().then(() => process.exit(0)).catch(err => { logger.error('bake failed', { err: String(err) }); process.exit(1); });
