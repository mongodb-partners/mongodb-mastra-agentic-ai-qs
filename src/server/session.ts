import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

/** Timing-safe comparison of two hex MAC strings (lengths may differ → not equal). */
function macEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Stateless session tokens (mirrors the MongodbUnpacked pattern). A token is a self-contained
 * HMAC `sid.exp.mac` — no server-side session store, so it scales to any number of workers with
 * zero shared state. The session id is derived ONLY from a verified token, never from the
 * request body, so a client cannot claim another session.
 */

export function newSessionId(): string { return randomUUID(); }

export function signToken(secret: string, sessionId: string, ttlSec = 1800): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const mac = createHmac('sha256', secret).update(`${sessionId}.${exp}`).digest('hex');
  return `${sessionId}.${exp}.${mac}`;
}

/** Return the session id if the token is well-formed, unexpired, and correctly signed; else null. */
export function verifyToken(secret: string, token: string | undefined, now = Date.now()): string | null {
  const [sid, exp, mac] = (token || '').split('.');
  if (!sid || !exp || !mac) return null;
  if (Number(exp) < Math.floor(now / 1000)) return null;
  const good = createHmac('sha256', secret).update(`${sid}.${exp}`).digest('hex');
  // Timing-safe HMAC comparison (crypto.timingSafeEqual) — does NOT short-circuit on the first
  // differing byte, so it leaks no per-byte timing signal.
  return macEqual(good, mac) ? sid : null;
}

/** Extract a Bearer token from an Authorization header value. */
export function bearer(authHeader: string | undefined | null): string | undefined {
  const h = authHeader || '';
  return h.startsWith('Bearer ') ? h.slice(7) : (h || undefined);
}
