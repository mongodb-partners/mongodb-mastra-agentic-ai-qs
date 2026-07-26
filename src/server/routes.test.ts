import { describe, it, expect } from 'vitest';
import { FEED_LIMIT } from './routes';

describe('FEED_LIMIT', () => {
  it('covers a full run of the current recording (~55-70 events) with headroom', () => {
    expect(FEED_LIMIT).toBe(120);
  });
});
