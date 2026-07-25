import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createApp } from './app';
import { mountRoutes } from './routes';
import { loadConfig } from '../config';

const cfg = { appName: 'Marshal', port: 8000 } as any;

describe('health route', () => {
  it('returns ok and the configured app name', async () => {
    const app = createApp(cfg);
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', app: 'Marshal' });
  });

  it('reflects a custom app name', async () => {
    const app = createApp({ ...cfg, appName: 'Case Zero' });
    const res = await app.request('/api/health');
    const body = (await res.json()) as { app: string };
    expect(body.app).toBe('Case Zero');
  });
});

describe('/api/mode', () => {
  // mountRoutes only registers handlers, so a stub Db/hub is enough to exercise a cfg-only route.
  // This is the ONE place both ends of the ui-mode contract are checked against each other: the
  // Playwright matrix stubs /api/mode, so without this a rename on either side would pass every
  // other test in the repo and only surface on stage.
  const mount = (cfg: object) => {
    const app = new Hono();
    mountRoutes(app, { demoMode: false, sessionSecret: 's', ...cfg } as any, {} as any, {} as any);
    return app;
  };

  it('carries the server ui defaults the client reads', async () => {
    const res = await mount({ uiMode: 'classic', uiDensity: 'lean' }).request('/api/mode');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ demoMode: false, uiMode: 'classic', uiDensity: 'lean' });
  });

  it('keeps demoMode intact when no ui override is set', async () => {
    const res = await mount({ demoMode: true, uiMode: '', uiDensity: '' }).request('/api/mode');
    expect(await res.json()).toEqual({ demoMode: true, uiMode: '', uiDensity: '' });
  });

  // loadConfig maps MARSHAL_UI=auto and MARSHAL_DENSITY=auto to '' (see src/config.ts), so 'auto'
  // must never reach the wire — the client's "no override" branch keys on falsiness, and a literal
  // 'auto' would read as an override named after a mode that does not exist. The Playwright
  // harnesses stub this payload, so this is the assertion that keeps their stubs honest.
  it("never serves 'auto' — loadConfig has already normalised it to ''", async () => {
    const cfg = loadConfig({
      MONGODB_URI: 'mongodb+srv://x',
      VOYAGE_API_KEY: 'vk',
      MARSHAL_UI: 'auto',
      MARSHAL_DENSITY: 'auto',
    });
    const res = await mount({ uiMode: cfg.uiMode, uiDensity: cfg.uiDensity }).request('/api/mode');
    expect(await res.json()).toEqual({ demoMode: false, uiMode: '', uiDensity: '' });
  });
});
