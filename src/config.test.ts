import { describe, it, expect } from 'vitest';
import { loadConfig } from './config';

const base = { MONGODB_URI: 'mongodb+srv://x', VOYAGE_API_KEY: 'vk' };

describe('loadConfig', () => {
  it('defaults the app name to Marshal', () => {
    expect(loadConfig(base).appName).toBe('Marshal');
  });
  it('overrides the app name from APP_NAME', () => {
    expect(loadConfig({ ...base, APP_NAME: 'Case Zero' }).appName).toBe('Case Zero');
  });
  it('requires MONGODB_URI', () => {
    expect(() => loadConfig({ VOYAGE_API_KEY: 'vk' })).toThrow(/MONGODB_URI/);
  });
  it('defaults db, provider, model, port, rrfK', () => {
    const c = loadConfig(base);
    expect(c.mongoDb).toBe('marshal');
    expect(c.llmProvider).toBe('anthropic');
    expect(c.llmModel).toBe('claude-haiku-4-5');
    expect(c.port).toBe(8000);
    expect(c.rrfK).toBe(60);
  });
  it('demoMode defaults off and turns on for true/1', () => {
    expect(loadConfig(base).demoMode).toBe(false);
    expect(loadConfig({ ...base, DEMO_MODE: 'true' }).demoMode).toBe(true);
    expect(loadConfig({ ...base, DEMO_MODE: '1' }).demoMode).toBe(true);
    expect(loadConfig({ ...base, DEMO_MODE: 'false' }).demoMode).toBe(false);
  });

  it('uses SEPARATE dev secrets for audit vs session in non-production', () => {
    const c = loadConfig(base);
    expect(c.auditSecret).toBeTruthy();
    expect(c.sessionSecret).toBeTruthy();
    expect(c.auditSecret).not.toBe(c.sessionSecret); // finding #1: never reuse one for the other
  });

  it('fails fast in production when secrets are unset and demo mode is off (finding #1)', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/AUDIT_SECRET|SESSION_SECRET/);
    // With both set, production is fine.
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', AUDIT_SECRET: 'a-real-audit', SESSION_SECRET: 'a-real-session' })).not.toThrow();
    // Demo mode in production is allowed without secrets (no live agent, replay only).
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', DEMO_MODE: '1' })).not.toThrow();
  });

  it('uiMode and uiDensity default to empty (viewport decides)', () => {
    const c = loadConfig(base);
    expect(c.uiMode).toBe('');
    expect(c.uiDensity).toBe('');
  });

  it('MARSHAL_UI=classic pins the classic layout fleet-wide', () => {
    expect(loadConfig({ ...base, MARSHAL_UI: 'classic' }).uiMode).toBe('classic');
  });

  it("normalises MARSHAL_UI=auto to '' so the client sees one shape", () => {
    expect(loadConfig({ ...base, MARSHAL_UI: 'auto' }).uiMode).toBe('');
  });

  it('rejects an unknown MARSHAL_UI rather than silently ignoring it', () => {
    expect(() => loadConfig({ ...base, MARSHAL_UI: 'clasic' })).toThrow(/MARSHAL_UI/);
  });

  it('accepts each MARSHAL_DENSITY tier and rejects anything else', () => {
    for (const d of ['full', 'lean', 'minimal'] as const) {
      expect(loadConfig({ ...base, MARSHAL_DENSITY: d }).uiDensity).toBe(d);
    }
    expect(() => loadConfig({ ...base, MARSHAL_DENSITY: 'tiny' })).toThrow(/MARSHAL_DENSITY/);
  });

  // The two ui variables must accept and normalise the same "let the viewport decide" spelling;
  // accepting 'auto' on one and hard-failing startup on the other is a trap for an operator writing
  // both lines of the same .env.
  it("normalises MARSHAL_DENSITY=auto to '', symmetric with MARSHAL_UI", () => {
    expect(loadConfig({ ...base, MARSHAL_DENSITY: 'auto' }).uiDensity).toBe('');
    expect(loadConfig({ ...base, MARSHAL_UI: 'auto', MARSHAL_DENSITY: 'auto' })).toMatchObject({
      uiMode: '',
      uiDensity: '',
    });
  });

  it('honors explicit secrets and keeps them distinct', () => {
    const c = loadConfig({ ...base, AUDIT_SECRET: 'aud', SESSION_SECRET: 'ses' });
    expect(c.auditSecret).toBe('aud');
    expect(c.sessionSecret).toBe('ses');
  });
});
