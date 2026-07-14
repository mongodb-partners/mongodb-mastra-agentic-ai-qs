import { describe, it, expect, vi, afterEach } from 'vitest';
import { logger, setLogSink } from './logger';

afterEach(() => setLogSink(null));

describe('logger', () => {
  it('emits single-line JSON to console.log for info', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.info('hello', { a: 1 });
    expect(spy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect(parsed).toMatchObject({ msg: 'hello', level: 'info', a: 1 });
    spy.mockRestore();
  });

  it('mirrors to an attached sink without throwing when the sink throws', () => {
    setLogSink({ write: () => { throw new Error('sink boom'); } });
    expect(() => logger.info('safe')).not.toThrow();
  });

  it('counts and snapshots counters', () => {
    logger.counter('probe', 2);
    logger.counter('probe');
    expect(logger.snapshot().probe).toBe(3);
  });
});
