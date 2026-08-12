/**
 * Per-test state isolation.
 *
 * Runs against a real jsdom `localStorage`/`sessionStorage` rather than mocks —
 * the whole point is whether the scrub script actually removes keys, and a mock
 * would only prove the code calls itself.
 *
 * The headline test is `given_a_leaked_key_then_the_next_test_does_not_inherit_it`:
 * that contamination is the failure this module exists to prevent, and it is a
 * false positive with a confident explanation attached — the worst kind.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_PRESERVED_KEYS,
  describeIsolation,
  detectLeakedKeys,
  fingerprintState,
  isolateBeforeTest,
} from '../../../src/core/executor/test-isolation';

/** Evaluator backed by the ambient jsdom window — the real storage APIs. */
const evaluate = (async <T,>(expression: string): Promise<T> => {
  // eslint-disable-next-line no-eval
  return eval(expression) as T;
}) as <T>(expression: string) => Promise<T>;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('storage scrub', () => {
  it('given_leftover_keys_then_they_are_removed', async () => {
    localStorage.setItem('draft', 'unsent text');
    localStorage.setItem('cart', '3 items');
    sessionStorage.setItem('wizardStep', '2');

    const r = await isolateBeforeTest(evaluate);

    expect(r.clearedLocalStorage).toBe(2);
    expect(r.clearedSessionStorage).toBe(1);
    expect(localStorage.getItem('draft')).toBeNull();
    expect(sessionStorage.getItem('wizardStep')).toBeNull();
  });

  it('given_auth_shaped_keys_then_they_are_PRESERVED', async () => {
    // Wiping the token would log every test out and make isolation unusable with
    // token auth — the feature would be correct and useless.
    localStorage.setItem('authToken', 'abc');
    localStorage.setItem('refreshToken', 'def');
    localStorage.setItem('jwt', 'ghi');
    localStorage.setItem('draft', 'clear me');

    const r = await isolateBeforeTest(evaluate);

    expect(localStorage.getItem('authToken')).toBe('abc');
    expect(localStorage.getItem('refreshToken')).toBe('def');
    expect(localStorage.getItem('jwt')).toBe('ghi');
    expect(localStorage.getItem('draft')).toBeNull();
    expect(r.preserved).toContain('authToken');
  });

  it('given_a_custom_token_key_then_it_can_be_preserved_too', async () => {
    localStorage.setItem('acme_credentials', 'xyz');
    await isolateBeforeTest(evaluate, { preserveKeys: [/acme_/i] });
    expect(localStorage.getItem('acme_credentials')).toBe('xyz');
  });

  it('given_isolation_level_none_then_nothing_is_touched', async () => {
    localStorage.setItem('draft', 'keep');
    const r = await isolateBeforeTest(evaluate, { level: 'none' });
    expect(localStorage.getItem('draft')).toBe('keep');
    expect(r.clearedLocalStorage).toBe(0);
  });

  it('given_empty_storage_then_it_reports_zero_without_error', async () => {
    const r = await isolateBeforeTest(evaluate);
    expect(r.clearedLocalStorage).toBe(0);
    expect(r.errors).toEqual([]);
  });

  it('given_an_evaluator_that_throws_then_it_degrades_and_REPORTS_rather_than_throwing', async () => {
    // Isolation failing is a degraded run, not a reason to abandon the suite — but
    // an unreported failure becomes a flake nobody can attribute.
    const broken = (async () => {
      throw new Error('CDP detached');
    }) as <T>(e: string) => Promise<T>;

    const r = await isolateBeforeTest(broken);
    expect(r.errors[0]).toMatch(/CDP detached/);
    expect(describeIsolation(r)).toMatch(/WARNING/);
  });
});

describe('the contamination this prevents', () => {
  it('given_a_leaked_key_then_the_next_test_does_not_inherit_it', async () => {
    // Test A finishes having written a draft.
    localStorage.setItem('draft', 'Test A left this behind');
    localStorage.setItem('authToken', 'still-logged-in');

    // Test B starts.
    await isolateBeforeTest(evaluate);

    // B sees a clean slate but is still authenticated — the exact combination a
    // suite needs.
    expect(localStorage.getItem('draft')).toBeNull();
    expect(localStorage.getItem('authToken')).toBe('still-logged-in');
  });

  it('given_repeated_isolation_then_it_is_idempotent', async () => {
    localStorage.setItem('draft', 'x');
    await isolateBeforeTest(evaluate);
    const second = await isolateBeforeTest(evaluate);
    expect(second.clearedLocalStorage).toBe(0);
    expect(second.errors).toEqual([]);
  });
});

describe('leak detection', () => {
  it('given_a_test_that_writes_a_new_key_then_it_is_reported_as_leaked', async () => {
    const before = await fingerprintState(evaluate);
    localStorage.setItem('orderDraft', 'created by the test');
    const after = await fingerprintState(evaluate);

    expect(detectLeakedKeys(before, after)).toEqual(['orderDraft']);
  });

  it('given_only_auth_keys_written_then_nothing_is_reported_as_leaked', async () => {
    // Logging in is not a leak.
    const before = await fingerprintState(evaluate);
    localStorage.setItem('authToken', 'fresh');
    const after = await fingerprintState(evaluate);
    expect(detectLeakedKeys(before, after)).toEqual([]);
  });

  it('given_a_key_that_already_existed_then_it_is_not_a_leak', async () => {
    localStorage.setItem('theme', 'dark');
    const before = await fingerprintState(evaluate);
    localStorage.setItem('theme', 'light');
    const after = await fingerprintState(evaluate);
    expect(detectLeakedKeys(before, after)).toEqual([]);
  });

  it('given_leaks_in_both_stores_then_both_are_reported_and_deduped', async () => {
    const before = await fingerprintState(evaluate);
    localStorage.setItem('a', '1');
    sessionStorage.setItem('a', '1');
    sessionStorage.setItem('b', '2');
    const after = await fingerprintState(evaluate);
    expect(detectLeakedKeys(before, after)).toEqual(['a', 'b']);
  });
});

describe('preserved-key defaults', () => {
  it('given_the_defaults_then_they_cover_the_common_token_names', () => {
    const names = ['authToken', 'auth', 'id_token', 'refreshToken', 'session_id', 'jwt'];
    for (const n of names) {
      expect(
        DEFAULT_PRESERVED_KEYS.some((re) => re.test(n)),
        `${n} should be preserved by default`
      ).toBe(true);
    }
  });

  it('given_ordinary_app_keys_then_they_are_NOT_preserved', () => {
    for (const n of ['draft', 'cart', 'theme', 'wizardStep', 'lastViewed']) {
      expect(
        DEFAULT_PRESERVED_KEYS.some((re) => re.test(n)),
        `${n} should be cleared`
      ).toBe(false);
    }
  });
});

describe('describeIsolation', () => {
  it('given_a_scrub_then_it_reports_counts_and_preservation', async () => {
    localStorage.setItem('draft', 'x');
    localStorage.setItem('authToken', 'y');
    const text = describeIsolation(await isolateBeforeTest(evaluate));
    expect(text).toMatch(/cleared 1 localStorage/);
    expect(text).toMatch(/preserved 1 auth-shaped key/);
  });

  it('given_level_none_then_it_says_state_carries_over', () => {
    expect(
      describeIsolation({
        level: 'none',
        clearedLocalStorage: 0,
        clearedSessionStorage: 0,
        clearedCookies: false,
        preserved: [],
        errors: [],
      })
    ).toMatch(/state carries between tests/);
  });
});
