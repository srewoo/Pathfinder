/**
 * Auth Session Manager for pathfinder.
 *
 * Handles:
 * 1. Injecting preset-supplied cookies before test execution (via CDP)
 * 2. Verifying auth state before and during tests
 * 3. Replaying login steps when session expires mid-test
 *
 * Reading the browser's own cookie jar was removed in fix.md §7.3 — a run
 * authenticates by performing a real login, never by borrowing the user's
 * session.
 */
import type { AuthCookie, ExecutionPreset, ExecutionStep } from '../../storage/schemas';
import { executionPresetStorage } from '../../storage/chrome-storage';
import { runStep } from './action-runner';
import { isAttached, waitForNetworkIdle, waitForDomSettle } from '../cdp/cdp-client';
import { injectCookies } from '../cookie-port';
import { createLogger } from '../../utils/logger';

const log = createLogger('auth-manager');

/**
 * Wait for the tab to stabilize after a login navigation/action. Uses the CDP
 * network-idle + DOM-settle signal when a session is attached (login flows fire
 * auth XHRs whose completion is exactly what we need to wait on); falls back to
 * a fixed sleep only when CDP is unavailable.
 */
async function settle(tabId: number, fallbackMs: number): Promise<void> {
  if (isAttached(tabId)) {
    await waitForNetworkIdle(tabId, { idleMs: 400, timeoutMs: Math.max(3_000, fallbackMs * 2) });
    await waitForDomSettle(tabId, 2_000);
  } else {
    await delay(fallbackMs);
  }
}

// ---------------------------------------------------------------------------
// Cookie Capture — snapshot current browser cookies for a domain
// ---------------------------------------------------------------------------

/**
 * REMOVED (fix.md §7.3): cookie capture from the user's live browser session.
 *
 * This previously called `chrome.cookies.getAll` to copy the user's real
 * session into a preset. That is the "borrow the live session" pattern §7.3
 * eliminates — it made every run capable of acting as the user against any
 * origin, and it is why the manifest requested the `cookies` permission.
 *
 * The capability is deleted rather than deprecated: authenticate through a
 * preset's `setupSteps` (a real login performed in the session) instead. Cookies
 * obtained that way already live in the session and need no capture.
 *
 * Kept as an explicitly throwing stub so any missed caller fails loudly at the
 * boundary rather than silently authenticating as nobody (CLAUDE.md §1.1).
 */
export async function captureAuthCookies(_url: string): Promise<never> {
  throw new Error(
    'captureAuthCookies was removed (fix.md §7.3): Pathfinder no longer reads the ' +
      "browser's cookie jar. Configure the preset's login steps instead."
  );
}

// ---------------------------------------------------------------------------
// Cookie Injection — restore saved cookies before test execution
// ---------------------------------------------------------------------------

/**
 * Inject saved auth cookies into the browser for the given URL.
 * This restores a previously authenticated session.
 */
export async function injectAuthCookies(
  tabId: number,
  url: string,
  cookies: AuthCookie[]
): Promise<number> {
  // Writes go through CDP `Network.setCookie` rather than `chrome.cookies.set`
  // (fix.md §7.3). Same effect for the target session, but scoped to the tab's
  // debugger session instead of the whole browser profile — which is what let
  // the `cookies` permission leave the manifest.
  const { injected } = await injectCookies(tabId, url, cookies);
  return injected;
}

// ---------------------------------------------------------------------------
// Auth State Verification — check if session is still valid
// ---------------------------------------------------------------------------

export type AuthStatus = 'authenticated' | 'expired' | 'unknown';

/**
 * Verify authentication state using multiple strategies:
 * 1. Check for a logout indicator selector on the page (fastest)
 * 2. Check for an auth indicator selector on the page
 * 3. Fetch the auth check URL and verify response status
 */
export async function verifyAuthState(
  tabId: number,
  preset: ExecutionPreset
): Promise<AuthStatus> {
  // Strategy 1: Check for logout indicator (session expired)
  if (preset.logoutIndicatorSelector) {
    const isLoggedOut = await checkSelectorVisible(tabId, preset.logoutIndicatorSelector);
    if (isLoggedOut) {
      log.info('Session expired — logout indicator visible');
      return 'expired';
    }
  }

  // Strategy 2: Check for auth indicator (still logged in)
  if (preset.authCheckSelector) {
    const isLoggedIn = await checkSelectorVisible(tabId, preset.authCheckSelector);
    return isLoggedIn ? 'authenticated' : 'expired';
  }

  // Strategy 3: Hit auth check URL
  if (preset.authCheckUrl) {
    try {
      const response = await fetch(preset.authCheckUrl, {
        method: 'GET',
        credentials: 'include',
        redirect: 'manual',
      });
      if (response.status === 200) return 'authenticated';
      if (response.status === 401 || response.status === 403) return 'expired';
    } catch {
      log.debug('Auth check URL unreachable');
    }
  }

  return 'unknown';
}

async function checkSelectorVisible(tabId: number, selector: string): Promise<boolean> {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      },
      args: [selector],
    });
    return result?.result ?? false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Login Replay — execute setup steps to re-authenticate
// ---------------------------------------------------------------------------

/**
 * Replay the login flow defined in the execution preset's setupSteps.
 * Each step is a natural language instruction converted to an ExecutionStep.
 *
 * Returns true if login replay completed without errors.
 */
export async function replayLogin(
  tabId: number,
  preset: ExecutionPreset
): Promise<boolean> {
  if (!preset.setupSteps || preset.setupSteps.length === 0) {
    log.warn('No setup steps defined for login replay');
    return false;
  }

  log.info(`Replaying login flow (${preset.setupSteps.length} steps) for preset "${preset.name}"`);

  // Navigate to start URL first
  if (preset.startUrl) {
    try {
      await new Promise<void>((resolve) => {
        let resolved = false;
        const done = () => {
          if (resolved) return;
          resolved = true;
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        };
        const listener = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
          if (updatedTabId === tabId && changeInfo.status === 'complete') done();
        };
        chrome.tabs.onUpdated.addListener(listener);
        chrome.tabs.update(tabId, { url: preset.startUrl });
        setTimeout(done, 15_000);
      });
      await settle(tabId, 2000);
    } catch {
      log.warn('Failed to navigate to login URL');
    }
  }

  // Execute each setup step as a basic action
  for (let i = 0; i < preset.setupSteps.length; i++) {
    const stepDesc = preset.setupSteps[i];
    const step = parseSetupStep(stepDesc, i);

    try {
      const result = await runStep(step, tabId);
      if (result.status === 'failed') {
        log.warn(`Login step ${i + 1} failed: ${result.error}`);
        return false;
      }
      await settle(tabId, 500);
    } catch (err) {
      log.warn(`Login step ${i + 1} threw: ${err}`);
      return false;
    }
  }

  // Wait for page to settle after login (auth redirect + session XHRs).
  await settle(tabId, 2000);
  log.info('Login replay completed');
  return true;
}

/**
 * Parse a natural language setup step into a basic ExecutionStep.
 * Supports simple formats like:
 *   "Click #login-button"
 *   "Type admin@example.com into #email"
 *   "Navigate to /dashboard"
 *   "Wait 2000"
 */
function parseSetupStep(description: string, order: number): ExecutionStep {
  const lower = description.toLowerCase().trim();

  // "click <selector>"
  const clickMatch = lower.match(/^click\s+(.+)$/);
  if (clickMatch) {
    return { order, action: 'click', selector: clickMatch[1].trim(), description };
  }

  // "type <value> into <selector>"
  const typeMatch = lower.match(/^type\s+(.+?)\s+into\s+(.+)$/);
  if (typeMatch) {
    return { order, action: 'type', value: typeMatch[1].trim(), selector: typeMatch[2].trim(), description };
  }

  // "navigate to <url>"
  const navMatch = lower.match(/^navigate\s+to\s+(.+)$/);
  if (navMatch) {
    return { order, action: 'navigate', value: navMatch[1].trim(), description };
  }

  // "wait <ms>"
  const waitMatch = lower.match(/^wait\s+(\d+)$/);
  if (waitMatch) {
    return { order, action: 'wait', timeout: parseInt(waitMatch[1], 10), description };
  }

  // "press <key>"
  const pressMatch = lower.match(/^press\s+(.+)$/);
  if (pressMatch) {
    return { order, action: 'press_key', key: pressMatch[1].trim(), description };
  }

  // "select <value> in <selector>"
  const selectMatch = lower.match(/^select\s+(.+?)\s+in\s+(.+)$/);
  if (selectMatch) {
    return { order, action: 'select', value: selectMatch[1].trim(), selector: selectMatch[2].trim(), description };
  }

  // Default: treat entire string as a click on a selector
  return { order, action: 'click', selector: description, description };
}

// ---------------------------------------------------------------------------
// Pre-Test Auth Setup — orchestrates cookie injection + verification
// ---------------------------------------------------------------------------

/**
 * Ensure the test tab is authenticated before execution begins.
 * Called by the test executor before each test run.
 *
 * Flow:
 * 1. If preset has saved cookies → inject them
 * 2. Navigate to start URL
 * 3. Verify auth state
 * 4. If expired → replay login steps
 * 5. After login → re-capture cookies for future runs
 */
export async function ensureAuthenticated(
  tabId: number,
  presetId: string | undefined,
  startUrl: string | undefined
): Promise<{ authenticated: boolean; method: 'cookies' | 'replay' | 'already' | 'skipped' }> {
  if (!presetId) {
    return { authenticated: true, method: 'skipped' };
  }

  const preset = await executionPresetStorage.getById(presetId);
  if (!preset || !preset.requiresAuthenticatedSession) {
    return { authenticated: true, method: 'skipped' };
  }

  const url = startUrl ?? preset.startUrl;
  if (!url) {
    log.warn('No URL available for auth setup');
    return { authenticated: true, method: 'skipped' };
  }

  // Step 1: Inject saved cookies
  if (preset.authCookies && preset.authCookies.length > 0) {
    await injectAuthCookies(tabId, url, preset.authCookies);
  }

  // Step 2: Check current auth state
  const status = await verifyAuthState(tabId, preset);

  if (status === 'authenticated') {
    log.info('Session already authenticated (cookies valid)');
    return { authenticated: true, method: preset.authCookies?.length ? 'cookies' : 'already' };
  }

  // Step 3: Replay login flow
  if (preset.setupSteps && preset.setupSteps.length > 0) {
    const success = await replayLogin(tabId, preset);
    if (success) {
      // No cookie re-capture (fix.md §7.3). A successful login already put the
      // session cookies in the tab's jar; reading them back out only existed to
      // persist them into a preset, which is the borrowing pattern we removed.
      return { authenticated: true, method: 'replay' };
    }
    log.warn('Login replay failed — proceeding without auth');
    return { authenticated: false, method: 'replay' };
  }

  log.warn('No login replay steps configured and cookies expired');
  return { authenticated: false, method: 'cookies' };
}

/**
 * Mid-test session recovery.
 * Called when a step fails and the error might be auth-related.
 * Checks auth state and re-authenticates if session expired.
 * Returns true if recovery was successful and the step should be retried.
 */
export async function recoverSessionIfExpired(
  tabId: number,
  presetId: string | undefined,
  startUrl: string | undefined,
  stepError: string
): Promise<boolean> {
  if (!presetId) return false;

  // Quick heuristic: only attempt recovery if the error looks auth-related
  const authErrorPatterns = /\b(401|403|unauthorized|forbidden|login|sign.?in|session.?expired|token.?expired|access.?denied)\b/i;
  if (!authErrorPatterns.test(stepError)) {
    // Also check if the page navigated to a login page
    try {
      const tab = await chrome.tabs.get(tabId);
      const url = tab.url?.toLowerCase() ?? '';
      if (!/(login|signin|auth|sso|oauth)/.test(url)) return false;
    } catch {
      return false;
    }
  }

  log.info('Possible session expiry detected — checking auth state');

  const preset = await executionPresetStorage.getById(presetId);
  if (!preset || !preset.requiresAuthenticatedSession) return false;

  const status = await verifyAuthState(tabId, preset);
  if (status === 'authenticated') {
    log.debug('Session still valid — not an auth issue');
    return false;
  }

  log.info('Session expired mid-test — attempting recovery');

  // Re-inject cookies and replay login
  const url = startUrl ?? preset.startUrl;
  if (url && preset.authCookies && preset.authCookies.length > 0) {
    await injectAuthCookies(tabId, url, preset.authCookies);
  }

  if (preset.setupSteps && preset.setupSteps.length > 0) {
    const success = await replayLogin(tabId, preset);
    if (success) {
      // No cookie re-capture after recovery (fix.md §7.3) — see ensureAuthenticated.
      log.info('Session recovered successfully — resuming test');

      // Navigate back to the page where the test was running
      if (url) {
        try {
          await chrome.tabs.update(tabId, { url });
          await settle(tabId, 2000);
        } catch { /* non-fatal */ }
      }
      return true;
    }
    log.warn('Session recovery failed');
    return false;
  }

  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
