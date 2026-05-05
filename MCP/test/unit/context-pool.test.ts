import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock playwright before importing the module under test
const newContextMock = vi.fn();
const closeContextMock = vi.fn();
const closeBrowserMock = vi.fn();

const browserStub = {
  newContext: newContextMock,
  close: closeBrowserMock,
};

const launchMock = vi.fn().mockResolvedValue(browserStub);

vi.mock('playwright', () => ({
  chromium: { launch: launchMock },
  firefox: { launch: launchMock },
  webkit: { launch: launchMock },
}));

const { acquireContext, closePool, poolStats } = await import('../../src/browser/context-pool');

beforeEach(() => {
  vi.useFakeTimers();
  launchMock.mockClear();
  newContextMock.mockReset();
  closeContextMock.mockReset();
  closeBrowserMock.mockReset();

  newContextMock.mockImplementation(() => Promise.resolve({ close: closeContextMock }));
  closeContextMock.mockResolvedValue(undefined);
  closeBrowserMock.mockResolvedValue(undefined);
});

afterEach(async () => {
  vi.useRealTimers();
  await closePool();
});

describe('context-pool', () => {
  it('given two acquires with same key when acquiring then reuses one context', async () => {
    const a = await acquireContext({ browser: 'chromium', headless: true });
    const b = await acquireContext({ browser: 'chromium', headless: true });
    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(newContextMock).toHaveBeenCalledTimes(1);
    expect(poolStats().contexts).toBe(1);
    expect(poolStats().refs[Object.keys(poolStats().refs)[0]]).toBe(2);
    a.release();
    b.release();
  });

  it('given different browsers when acquiring then launches separate browsers', async () => {
    const a = await acquireContext({ browser: 'chromium' });
    const b = await acquireContext({ browser: 'firefox' });
    expect(launchMock).toHaveBeenCalledTimes(2);
    expect(poolStats().browsers).toBe(2);
    a.release();
    b.release();
  });

  it('given different storageStatePaths when acquiring then creates separate contexts', async () => {
    const a = await acquireContext({ storageStatePath: '/auth-a.json' });
    const b = await acquireContext({ storageStatePath: '/auth-b.json' });
    expect(newContextMock).toHaveBeenCalledTimes(2);
    expect(poolStats().contexts).toBe(2);
    // Same browser shared
    expect(launchMock).toHaveBeenCalledTimes(1);
    a.release();
    b.release();
  });

  it('given context released then re-acquired before TTL when acquiring then keeps same context', async () => {
    const a = await acquireContext();
    a.release();
    const b = await acquireContext();
    expect(newContextMock).toHaveBeenCalledTimes(1);
    b.release();
  });

  it('given context idle past TTL when timer fires then closes context', async () => {
    const a = await acquireContext();
    a.release();
    expect(poolStats().contexts).toBe(1);
    vi.advanceTimersByTime(60_001);
    await Promise.resolve();
    await Promise.resolve();
    expect(closeContextMock).toHaveBeenCalled();
  });

  it('given closePool called when shutting down then closes all contexts and browsers', async () => {
    await acquireContext({ browser: 'chromium' });
    await acquireContext({ browser: 'firefox' });
    await closePool();
    expect(closeContextMock).toHaveBeenCalledTimes(2);
    expect(closeBrowserMock).toHaveBeenCalledTimes(2);
    expect(poolStats().contexts).toBe(0);
    expect(poolStats().browsers).toBe(0);
  });

  it('given storageStatePath when acquiring then passes it to newContext', async () => {
    await acquireContext({ storageStatePath: '/auth.json' });
    const opts = newContextMock.mock.calls[0][0];
    expect(opts.storageState).toBe('/auth.json');
  });

  it('given unknown browser name when acquiring then throws', async () => {
    await expect(
      acquireContext({ browser: 'safari' as never }),
    ).rejects.toThrow(/Unsupported browser/);
  });
});
