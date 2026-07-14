import { describe, it, expect } from 'vitest';
import { sanitize, WATCHED_COLLECTIONS } from './change-stream-sse';

describe('change-stream SSE helpers', () => {
  it('sanitize drops embedding and _id but keeps the rest', () => {
    const out = sanitize({ _id: 'x', embedding: [1, 2, 3], transaction_id: 't', status: 'pending' });
    expect(out).toEqual({ transaction_id: 't', status: 'pending' });
  });
  it('sanitize passes null through', () => {
    expect(sanitize(null)).toBeNull();
  });
  it('watches the control-room collections including the agent-events feed, analysis and policies', () => {
    expect(WATCHED_COLLECTIONS).toEqual(['transactions', 'cases', 'case_decisions', 'reviews', 'audit_trail', 'agent_events', 'case_analysis', 'policies']);
  });
});
