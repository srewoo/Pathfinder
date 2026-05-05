/**
 * Auth Session Manager for pathfinder.
 *
 * Handles:
 * 1. Capturing cookies from the current browser session
 * 2. Injecting saved cookies before test execution
 * 3. Verifying auth state before and during tests
 * 4. Replaying login steps when session expires mid-test
 */
import type { AuthCookie, ExecutionPreset, ExecutionStep } from '../../storage/schemas';
import { executionPresetStorage } from '../../storage/chrome-storage';
import { runStep } from './action-runner';
import { createLogger } from '../../utils/logger';

const log = createLogger('auth-manager');

// ---------------------------------------------------------------------------
// Cookie Capture — snapshot current browser cookies for a domain
// ---------------------------------------------------------------------------

/**
 * Capture all cookies for the given URL's domain.
 * Uses the chrome.cookies API to read actual browser cookies.
 */
export async function captureAuthCookies(url: string): Promise<AuthCookie[]> {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    return cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite as AuthCookie['sameSite'],
      expirationDate: c.expirationDate,
    }));
  } catch (err) {
    log.warn('Failed to capture cookies', err);
    return [];
  }
}

/**
 * Save captured cookies to an execution preset.
 */
export async function saveCookiesToPreset(presetId: string, cookies: AuthCookie[]): Promise<void> {
  const preset = await executionPresetStorage.getById(presetId);
  if (!preset) {
    throw new Error(`Preset ${presetId} not found`);
  }

  await executionPresetStorage.upsert({
    ...preset,
    authCookies: cookies,
    updatedAt: new Date().toISOString(),
  });

  log.info(`Saved ${cookies.length} auth cookies to preset "${preset.name}"`);
}

// ---------------------------------------------------------------------------
// Cookie Injection — restore saved cookies before test execution
// ---------------------------------------------------------------------------

/**
 * Inject saved auth cookies into the browser for the given URL.
 * This restores a previously authenticated session.
 */
export async function injectAuthCookies(url: string, cookies: AuthCookie[]): Promise<number> {
  let injected = 0;

  for (const cookie of cookies) {
    try {
      // Skip expired cookies
      if (cookie.expirationDate && cookie.expirationDate * 1000 < Date.now()) {
        log.debug(`Skipping expired cookie: ${cookie.name}`);
        continue;
      }

      await chrome.cookies.set({
        url,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        expirationDate: cookie.expirationDate,
      });
      injected++;
    } catch (err) {
      log.debug(`Failed to inject cookie ${cookie.name}`, err);
    }
  }

  log.info(`Injected ${injected}/${cookies.length} auth cookies for ${url}`);
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
      await delay(2000);
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
      await delay(500);
    } catch (err) {
      log.warn(`Login step ${i + 1} threw: ${err}`);
      return false;
    }
  }

  // Wait for page to settle after login
  await delay(2000);
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
    await injectAuthCookies(url, preset.authCookies);
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
      // Re-capture cookies after successful login for future runs
      const freshCookies = await captureAuthCookies(url);
      if (freshCookies.length > 0) {
        await saveCookiesToPreset(preset.id, freshCookies);
      }
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
    await injectAuthCookies(url, preset.authCookies);
  }

  if (preset.setupSteps && preset.setupSteps.length > 0) {
    const success = await replayLogin(tabId, preset);
    if (success) {
      // Re-capture cookies after successful recovery
      if (url) {
        const freshCookies = await captureAuthCookies(url);
        if (freshCookies.length > 0) {
          await saveCookiesToPreset(preset.id, freshCookies);
        }
      }
      log.info('Session recovered successfully — resuming test');

      // Navigate back to the page where the test was running
      if (url) {
        try {
          await chrome.tabs.update(tabId, { url });
          await delay(2000);
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
