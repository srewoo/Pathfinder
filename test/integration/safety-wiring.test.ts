/**
 * Proves §7 enforcement is WIRED, not merely available.
 *
 * The gap this closes: `origin-policy` and `cdp-safety` were both fully tested in
 * isolation while nothing ever called `installSafety`, so at runtime there was no
 * allowlist and no method gate at all. Unit tests on the policy could not catch
 * that — only a test that goes through session setup can.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const attach = vi.fn().mockResolvedValue(undefined);
const detach = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/core/cdp/cdp-client', () => ({
  attach,
  detach,
  isAttached: vi.fn().mockReturnValue(true),
  enableDialogAutoDismiss: vi.fn().mockResolvedValue(undefined),
  registerDialogHandler: vi.fn(),
  unregisterDialogHandler: vi.fn(),
  startHARCapture: vi.fn().mockResolvedValue(undefined),
  stopHARCapture: vi.fn().mockResolvedValue([]),
  getHAREntries: vi.fn().mockReturnValue([]),
  getAccessibilityTree: vi.fn().mockResolvedValue([]),
  serializeAXTree: vi.fn().mockReturnValue(''),
  captureFullPageScreenshot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/core/step-executor', () => ({
  releaseTab: vi.fn(),
}));

const {
  initCDPSession,
  teardownCDPSession,
  getRunLedger,
  getRunPolicy,
  isEnforcementActive,
} = await import('../../src/core/cdp/cdp-session');

const { registerSafetyInstaller, clearSafetyInstaller } = await import(
  '../../src/core/safety/safety-port'
);
const { decide } = await import('../../src/core/safety/origin-policy');

const TAB = 42;

/** Records what the installer was handed, and lets us replay requests. */
function fakeInstaller() {
  const calls: Array<{ tabId: number; policy: unknown }> = [];
  let disposed = 0;
  registerSafetyInstaller(async (tabId, policy, ledger) => {
    calls.push({ tabId, policy });
    return {
      async dispose() {
        disposed++;
      },
      abortedCount: () => 0,
      // Exposed for the test to drive requests through the real policy.
      _replay(url: string, method: string) {
        const d = decide({ url, method }, policy);
        if (method === 'POST' || method === 'DELETE' || !d.allow) {
          ledger.record(
            d.allow
              ? { url, method, outcome: 'permitted' }
              : { url, method, outcome: 'refused', reason: d.reason, rule: d.rule },
            1
          );
        }
        return d;
      },
    } as never;
  });
  return { calls, disposed: () => disposed };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearSafetyInstaller();
});

afterEach(() => {
  clearSafetyInstaller();
});

describe('enforcement is installed by session setup', () => {
  it('given_a_session_with_a_start_url_then_the_installer_receives_that_origin', async () => {
    const installer = fakeInstaller();
    await initCDPSession(TAB, { startUrl: 'https://app.test/login' });

    expect(installer.calls).toHaveLength(1);
    expect(installer.calls[0].tabId).toBe(TAB);
    expect(getRunPolicy(TAB)?.allowedOrigins).toEqual(['https://app.test']);
    expect(isEnforcementActive(TAB)).toBe(true);
  });

  it('given_a_session_then_a_mutation_ledger_exists_for_the_run', async () => {
    fakeInstaller();
    await initCDPSession(TAB, { startUrl: 'https://app.test/' });
    expect(getRunLedger(TAB)).not.toBeNull();
  });

  it('given_no_start_url_then_enforcement_is_skipped_and_flagged_rather_than_silently_absent', async () => {
    // Failing closed would abort every request and look like a broken network.
    // Skipping silently would be worse. So: skipped, and reported as inactive.
    const installer = fakeInstaller();
    await initCDPSession(TAB, {});
    expect(installer.calls).toHaveLength(0);
    expect(isEnforcementActive(TAB)).toBe(false);
  });

  it('given_no_registered_installer_then_the_run_is_reported_unprotected', async () => {
    // This is the exact failure mode that shipped: policy present, nothing
    // installing it.
    await initCDPSession(TAB, { startUrl: 'https://app.test/' });
    expect(isEnforcementActive(TAB)).toBe(false);
  });
});

describe('the installed policy actually refuses the right requests', () => {
  it('given_a_read_only_run_then_an_allowlisted_POST_is_refused', async () => {
    const installer = fakeInstaller();
    await initCDPSession(TAB, { startUrl: 'https://app.test/' });
    const policy = getRunPolicy(TAB)!;
    expect(decide({ url: 'https://app.test/api/orders', method: 'POST' }, policy).allow).toBe(
      false
    );
    expect(installer.calls).toHaveLength(1);
  });

  it('given_a_read_only_run_then_an_offlist_GET_is_refused', async () => {
    fakeInstaller();
    await initCDPSession(TAB, { startUrl: 'https://app.test/' });
    const policy = getRunPolicy(TAB)!;
    const d = decide({ url: 'https://prod.corp/api', method: 'GET' }, policy);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.rule).toBe('origin');
  });

  it('given_an_explicit_mutation_opt_in_then_allowlisted_writes_pass_but_offlist_still_does_not', async () => {
    fakeInstaller();
    await initCDPSession(TAB, { startUrl: 'https://app.test/', allowMutations: true });
    const policy = getRunPolicy(TAB)!;
    expect(decide({ url: 'https://app.test/api', method: 'POST' }, policy).allow).toBe(true);
    expect(decide({ url: 'https://prod.corp/api', method: 'DELETE' }, policy).allow).toBe(false);
  });
});

describe('teardown', () => {
  it('given_teardown_then_enforcement_is_disposed', async () => {
    // An undisposed Fetch listener outlives the run (CLAUDE.md §11.1).
    const installer = fakeInstaller();
    await initCDPSession(TAB, { startUrl: 'https://app.test/' });
    await teardownCDPSession(TAB);
    expect(installer.disposed()).toBe(1);
  });

  it('given_teardown_then_the_run_state_is_cleared', async () => {
    fakeInstaller();
    await initCDPSession(TAB, { startUrl: 'https://app.test/' });
    await teardownCDPSession(TAB);
    expect(getRunLedger(TAB)).toBeNull();
    expect(getRunPolicy(TAB)).toBeNull();
  });

  it('given_teardown_called_twice_then_it_does_not_throw', async () => {
    fakeInstaller();
    await initCDPSession(TAB, { startUrl: 'https://app.test/' });
    await teardownCDPSession(TAB);
    await expect(teardownCDPSession(TAB)).resolves.toBeDefined();
  });
});
