import { describe, it, expect } from 'vitest';
import { parseMajorMinor, supportsRankFusion } from './provision-transactions';

describe('rank-fusion version guard', () => {
  it('parses major.minor', () => {
    expect(parseMajorMinor('8.0.4')).toEqual([8, 0]);
    expect(parseMajorMinor('7.3.1')).toEqual([7, 3]);
  });
  it('accepts 8.0+ and rejects older', () => {
    expect(supportsRankFusion('8.0.0')).toBe(true);
    expect(supportsRankFusion('8.1.2')).toBe(true);
    expect(supportsRankFusion('7.0.14')).toBe(false);
    expect(supportsRankFusion('6.0.0')).toBe(false);
  });
});
