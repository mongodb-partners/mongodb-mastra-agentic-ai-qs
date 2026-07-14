import { describe, it, expect } from 'vitest';
import { recordingSource, REPLAY_COLLECTIONS, RECORDING_COLLECTIONS } from './replay-store';

describe('recordingSource', () => {
  it('reads working collections in live mode', () => {
    expect(recordingSource(false)).toEqual({
      events: 'agent_events', analysis: 'case_analysis', reviews: 'reviews', audit: 'audit_trail',
    });
  });
  it('reads the immutable replay copies in demo mode', () => {
    expect(recordingSource(true)).toEqual({
      events: 'replay_events', analysis: 'replay_analysis', reviews: 'replay_reviews', audit: 'replay_audit',
    });
  });
  it('maps every working recording collection to a distinct replay copy', () => {
    const copies = Object.values(REPLAY_COLLECTIONS);
    expect(new Set(copies).size).toBe(RECORDING_COLLECTIONS.length);
    // A replay copy must never collide with a working collection name (that would defeat isolation).
    for (const c of copies) expect(RECORDING_COLLECTIONS).not.toContain(c);
  });
});
