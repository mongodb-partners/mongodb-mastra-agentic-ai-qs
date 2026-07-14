import { describe, it, expect } from 'vitest';
import { createApp } from './app';

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
