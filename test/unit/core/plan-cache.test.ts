import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExecutionPlan } from '../../../src/storage/schemas';

vi.mock('../../../src/storage/indexed-db', () => ({
  planDB: {
    put: vi.fn(),
    getByHash: vi.fn(),
  },
}));

vi.mock('../../../src/utils/hash', () => ({
  sha256: vi.fn(async (input: string) => `sha:${input}`),
  generateId: vi.fn(() => 'gen-id'),
}));

const { computePlanHash, getCachedPlan, cachePlan } = await import('../../../src/core/planner/plan-cache');
const { planDB } = await import('../../../src/storage/indexed-db');
const { sha256 } = await import('../../../src/utils/hash');

const baseStep = { order: 1, action: 'click' as const, description: 'click x' };

function makePlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    id: 'p1',
    testCaseId: 'tc-1',
    testCaseHash: 'h-1',
    steps: [baseStep],
    cachedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('computePlanHash', () => {
  beforeEach(() => vi.clearAllMocks());

  it('given url and element count when hashing then buckets count by 10', async () => {
    await computePlanHash('sig', 'https://x.com/foo', 27);
    expect(sha256).toHaveBeenCalledWith('sig::/foo::20');
  });

  it('given missing element count when hashing then defaults to 0', async () => {
    await computePlanHash('sig', 'https://x.com/foo');
    expect(sha256).toHaveBeenCalledWith('sig::/foo::0');
  });

  it('given empty url when hashing then uses no-page sentinel', async () => {
    await computePlanHash('sig', '', 5);
    expect(sha256).toHaveBeenCalledWith('sig::no-page::0');
  });

  it('given malformed url when hashing then falls back to raw string', async () => {
    await computePlanHash('sig', 'not a url', 0);
    expect(sha256).toHaveBeenCalledWith('sig::not a url::0');
  });

  it('given url without pathname when hashing then uses /', async () => {
    await computePlanHash('sig', 'https://x.com', 0);
    expect(sha256).toHaveBeenCalledWith('sig::/::0');
  });

  it('given counts in same bucket when hashing then produces same key', async () => {
    await computePlanHash('sig', 'https://x.com/a', 21);
    await computePlanHash('sig', 'https://x.com/a', 29);
    const calls = vi.mocked(sha256).mock.calls.map((c) => c[0]);
    expect(calls[0]).toBe(calls[1]);
  });
});

describe('getCachedPlan', () => {
  beforeEach(() => vi.clearAllMocks());

  it('given no plan in store when getting then returns undefined', async () => {
    vi.mocked(planDB.getByHash).mockResolvedValue(undefined);
    expect(await getCachedPlan('h', 'tc-1')).toBeUndefined();
  });

  it('given plan belongs to different test case when getting then returns undefined', async () => {
    vi.mocked(planDB.getByHash).mockResolvedValue(makePlan({ testCaseId: 'tc-other' }));
    expect(await getCachedPlan('h', 'tc-1')).toBeUndefined();
  });

  it('given plan older than TTL when getting then returns undefined', async () => {
    const stale = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    vi.mocked(planDB.getByHash).mockResolvedValue(makePlan({ cachedAt: stale }));
    expect(await getCachedPlan('h', 'tc-1')).toBeUndefined();
  });

  it('given fresh matching plan when getting then returns plan', async () => {
    const plan = makePlan();
    vi.mocked(planDB.getByHash).mockResolvedValue(plan);
    expect(await getCachedPlan('h', 'tc-1')).toBe(plan);
  });

  it('given plan exactly at TTL boundary when getting then is treated as fresh', async () => {
    // age == TTL is not strictly greater, so still valid
    const boundary = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    vi.mocked(planDB.getByHash).mockResolvedValue(makePlan({ cachedAt: boundary }));
    const result = await getCachedPlan('h', 'tc-1');
    expect(result).toBeDefined();
  });
});

describe('cachePlan', () => {
  beforeEach(() => vi.clearAllMocks());

  it('given partial plan when caching then fills id, testCaseId, hash, cachedAt', async () => {
    const before = Date.now();
    const result = await cachePlan('tc-1', 'h-1', { steps: [baseStep] });
    expect(result.id).toBe('gen-id');
    expect(result.testCaseId).toBe('tc-1');
    expect(result.testCaseHash).toBe('h-1');
    expect(new Date(result.cachedAt).getTime()).toBeGreaterThanOrEqual(before);
    expect(planDB.put).toHaveBeenCalledWith(result);
  });
});
