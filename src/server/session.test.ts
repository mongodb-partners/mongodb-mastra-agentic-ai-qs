import { describe, it, expect } from 'vitest';
import { newSessionId, signToken, verifyToken, bearer } from './session';

const SECRET = 'test-secret';

describe('session tokens', () => {
  it('round-trips a signed token to its session id', () => {
    const sid = newSessionId();
    const tok = signToken(SECRET, sid);
    expect(verifyToken(SECRET, tok)).toBe(sid);
  });

  it('rejects a token signed with a different secret', () => {
    const tok = signToken(SECRET, newSessionId());
    expect(verifyToken('other-secret', tok)).toBeNull();
  });

  it('rejects a tampered session id', () => {
    const tok = signToken(SECRET, 'sid-A');
    const [, exp, mac] = tok.split('.');
    expect(verifyToken(SECRET, `sid-B.${exp}.${mac}`)).toBeNull();
  });

  it('rejects an expired token', () => {
    const tok = signToken(SECRET, 'sid', 1); // 1s ttl
    const future = Date.now() + 5000;
    expect(verifyToken(SECRET, tok, future)).toBeNull();
  });

  it('rejects malformed tokens', () => {
    expect(verifyToken(SECRET, undefined)).toBeNull();
    expect(verifyToken(SECRET, 'garbage')).toBeNull();
    expect(verifyToken(SECRET, 'a.b')).toBeNull();
  });

  it('extracts a bearer token', () => {
    expect(bearer('Bearer xyz')).toBe('xyz');
    expect(bearer('xyz')).toBe('xyz');
    expect(bearer(undefined)).toBeUndefined();
  });
});
