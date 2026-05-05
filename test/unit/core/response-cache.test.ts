import { describe, it, expect, beforeEach } from 'vitest';
import {
  isCacheable,
  buildCacheKey,
  getCached,
  setCached,
  clearResponseCache,
  configureResponseCache,
  getCacheStats,
  resetCacheStats,
} from '../../../src/core/ai/response-cache';
import type { Message } from '../../../src/core/ai/ai-client';

const msgs: Message[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'hello' },
];

beforeEach(() => {
  clearResponseCache();
  resetCacheStats();
  configureResponseCache({ maxEntries: 200, ttlMs: 30 * 60 * 1000 });
});

describe('isCacheable', () => {
  it('given temperature=0 when checked then cacheable', () => {
    expect(isCacheable({ temperature: 0 })).toBe(true);
  });
  it('given temperature=0.1 when checked then cacheable', () => {
    expect(isCacheable({ temperature: 0.1 })).toBe(true);
  });
  it('given temperature=0.5 when checked then not cacheable', () => {
    expect(isCacheable({ temperature: 0.5 })).toBe(false);
  });
  it('given temperature unset when checked then not cacheable', () => {
    expect(isCacheable({})).toBe(false);
  });
  it('given undefined options when checked then not cacheable', () => {
    expect(isCacheable(undefined)).toBe(false);
  });
});

describe('buildCacheKey', () => {
  it('given identical inputs when hashed then equal keys', () => {
    const a = buildCacheKey('m', msgs, { temperature: 0 });
    const b = buildCacheKey('m', msgs, { temperature: 0 });
    expect(a).toBe(b);
  });

  it('given different model when hashed then different keys', () => {
    const a = buildCacheKey('m1', msgs, { temperature: 0 });
    const b = buildCacheKey('m2', msgs, { temperature: 0 });
    expect(a).not.toBe(b);
  });

  it('given different message text when hashed then different keys', () => {
    const a = buildCacheKey('m', msgs, { temperature: 0 });
    const b = buildCacheKey('m', [{ role: 'user', content: 'world' }], { temperature: 0 });
    expect(a).not.toBe(b);
  });
});

describe('cache get/set', () => {
  it('given empty cache when getting then misses and increments stat', () => {
    expect(getCached('k')).toBeUndefined();
    expect(getCacheStats().misses).toBe(1);
  });

  it('given set then get when hit then increments hits', () => {
    setCached('k', 'v');
    expect(getCached('k')).toBe('v');
    expect(getCacheStats().hits).toBe(1);
  });

  it('given expired entry when getting then returns undefined and evicts', () => {
    configureResponseCache({ ttlMs: 1 });
    setCached('k', 'v');
    const stale = Date.now() + 100;
    const realDate = Date.now;
    Date.now = () => stale;
    try {
      expect(getCached('k')).toBeUndefined();
    } finally {
      Date.now = realDate;
    }
    expect(getCacheStats().evictions).toBeGreaterThan(0);
  });

  it('given size > max when setting then evicts oldest', () => {
    configureResponseCache({ maxEntries: 2 });
    setCached('a', '1');
    setCached('b', '2');
    setCached('c', '3');
    expect(getCached('a')).toBeUndefined();
    expect(getCached('b')).toBe('2');
    expect(getCached('c')).toBe('3');
  });
});
