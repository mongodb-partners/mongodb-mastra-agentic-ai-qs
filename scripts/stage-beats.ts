import { MongoClient } from 'mongodb';
import { loadConfig } from '../src/config';
import { recordingSource } from '../src/data/replay-store';

/**
 * Live demo helpers. Each is a REAL database write — the console reacts through the change
 * stream, nothing is staged client-side.
 *
 *   pnpm beat:policy    touch a policy doc      -> "POLICY UPDATED LIVE" banner in every console
 *   pnpm beat:tamper    corrupt one audit field -> "AUDIT CHAIN BROKEN" alarm (chip turns red)
 *   pnpm beat:restore   undo the tampering      -> "AUDIT CHAIN RESTORED" banner
 *
 * Mode-aware: the audit beats target whichever chain the console verifies — the working
 * `audit_trail` in live mode, the frozen `replay_audit` copy in demo mode (restored afterwards,
 * so the recording returns to its baked state). Run with the SAME DEMO_MODE as the server.
 */
async function main() {
  try { process.loadEnvFile(); } catch { /* .env optional */ }
  const cfg = loadConfig();
  const auditCol = recordingSource(cfg.demoMode).audit;
  const client = new MongoClient(cfg.mongoUri);
  await client.connect();
  const db = client.db(cfg.mongoDb);
  const step = process.argv[2];
  if (step === 'policy') {
    const r = await db.collection('policies').updateOne({}, { $set: { last_reviewed: new Date() } });
    console.log(r.modifiedCount ? 'policy touched — watch the banner' : 'no policies found (run pnpm provision)');
  } else if (step === 'tamper') {
    const doc = await db.collection(auditCol).findOne({ event_type: { $ne: 'TAMPERED' } });
    if (!doc) { console.log(`no audit records in ${auditCol} to tamper with (bake or run an investigation first)`); }
    else {
      await db.collection(auditCol).updateOne(
        { _id: doc._id },
        { $set: { event_type: 'TAMPERED', original_event_type: doc.event_type } },
      );
      console.log(`tampered one ${auditCol} record — the console should raise the alarm`);
    }
  } else if (step === 'restore') {
    const doc = await db.collection(auditCol).findOne({ event_type: 'TAMPERED' });
    if (!doc) { console.log('nothing to restore'); }
    else {
      await db.collection(auditCol).updateOne(
        { _id: doc._id },
        { $set: { event_type: doc.original_event_type }, $unset: { original_event_type: '' } },
      );
      console.log('restored — the chain verifies again');
    }
  } else {
    console.log('usage: tsx scripts/stage-beats.ts policy|tamper|restore');
  }
  await client.close();
}
main().then(() => process.exit(0)).catch(err => { console.error(String(err)); process.exit(1); });
