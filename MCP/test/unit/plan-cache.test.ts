import { describe, it, expect } from 'vitest';
import { computePlanHash } from '../../src/core/planner/plan-cache.js';

describe('computePlanHash', () => {
  it('given_same_inputs_when_hashed_then_returns_same_hash', async () => {
    const hash1 = await computePlanHash('Login test', 'https://app.com/login');
    const hash2 = await computePlanHash('Login test', 'https://app.com/login');
    expect(hash1).toBe(hash2);
  });

  it('given_different_signatures_when_hashed_then_returns_different_hash', async () => {
    const hash1 = await computePlanHash('Login test', 'https://app.com/login');
    const hash2 = await computePlanHash('Signup test', 'https://app.com/login');
    expect(hash1).not.toBe(hash2);
  });

  it('given_different_pages_when_hashed_then_returns_different_hash', async () => {
    const hash1 = await computePlanHash('Login test', 'https://app.com/login');
    const hash2 = await computePlanHash('Login test', 'https://app.com/dashboard');
    expect(hash1).not.toBe(hash2);
  });

  it('given_same_path_different_origin_when_hashed_then_returns_same_hash', async () => {
    // Hash is based on pathname, not full URL — enables cross-environment caching
    const hash1 = await computePlanHash('Login test', 'https://staging.app.com/login');
    const hash2 = await computePlanHash('Login test', 'https://prod.app.com/login');
    expect(hash1).toBe(hash2);
  });

  it('given_invalid_url_when_hashed_then_uses_raw_string', async () => {
    const hash = await computePlanHash('Test', 'not-a-url');
    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(0);
  });

  it('given_empty_page_url_when_hashed_then_handles_gracefully', async () => {
    const hash = await computePlanHash('Test', '');
    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(0);
  });
});
