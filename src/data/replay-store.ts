import type { Db } from 'mongodb';

/**
 * Demo-replay isolation.
 *
 * A recorded run lives in four "working" collections that the LIVE pipeline also writes to and
 * that a live reset clears. If demo mode read straight from those, a single live run (or reset)
 * would corrupt or destroy the recording — which is exactly what happens when someone switches
 * between modes on the same cluster.
 *
 * So `pnpm bake` snapshots the recording into dedicated, immutable `replay_*` collections. Demo
 * mode reads ONLY from those; live runs and resets never touch them. The two modes can now coexist
 * on one cluster indefinitely.
 */

/** The working collections the pipeline writes to during a run (and a live reset clears). */
export const RECORDING_COLLECTIONS = ['agent_events', 'case_analysis', 'reviews', 'audit_trail'] as const;
export type RecordingCollection = (typeof RECORDING_COLLECTIONS)[number];

/** Immutable replay copies, read in demo mode. Never written at runtime — only by `pnpm bake`. */
export const REPLAY_COLLECTIONS: Record<RecordingCollection, string> = {
  agent_events: 'replay_events',
  case_analysis: 'replay_analysis',
  reviews: 'replay_reviews',
  audit_trail: 'replay_audit',
};

export interface RecordingSource { events: string; analysis: string; reviews: string; audit: string }

/** Collection names the read APIs should use for recorded content, given the runtime mode. */
export function recordingSource(demoMode: boolean): RecordingSource {
  return demoMode
    ? {
        events: REPLAY_COLLECTIONS.agent_events, analysis: REPLAY_COLLECTIONS.case_analysis,
        reviews: REPLAY_COLLECTIONS.reviews, audit: REPLAY_COLLECTIONS.audit_trail,
      }
    : { events: 'agent_events', analysis: 'case_analysis', reviews: 'reviews', audit: 'audit_trail' };
}

/**
 * Snapshot every working recording collection into its immutable replay copy (drop + copy,
 * preserving `_id`). Idempotent — safe to run after every bake. Returns per-collection doc counts.
 */
export async function snapshotReplay(db: Db): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const src of RECORDING_COLLECTIONS) {
    const dst = REPLAY_COLLECTIONS[src];
    const docs = await db.collection(src).find({}).toArray();
    await db.collection(dst).deleteMany({});
    if (docs.length) await db.collection(dst).insertMany(docs);
    counts[dst] = docs.length;
  }
  return counts;
}
