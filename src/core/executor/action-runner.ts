import type { ExecutionStep, StepResult } from '../../storage/schemas';
import { isNetworkAssertion, evaluateNetworkAssertion } from './network-assertion';
import { isAttached, waitForNetworkIdle } from '../cdp/cdp-client';
import { canExecuteStep, executeStep } from '../step-executor';
import { createLogger } from '../../utils/logger';

const log = createLogger('action-runner');

const DEFAULT_TIMEOUT = 15000;
const NAVIGATE_TIMEOUT = 20000;
const POST_NAVIGATE_MIN_MS = 500;
const POST_NAVIGATE_MAX_MS = 8000;
/** Max step-level retries for transient failures (timeout, detached session). */
const STEP_RETRY_ATTEMPTS = 2;
const STEP_RETRY_DELAY_MS = 500;

export async function runStep(step: ExecutionStep, tabId: number): Promise<StepResult> {
  const start = Date.now();

  try {
    if (step.action === 'navigate') {
      await navigateTab(tabId, step.value ?? '');
      return {
        step,
        status: 'passed',
        duration: Date.now() - start,
      };
    }

    // Network/API assertions are evaluated against captured HAR in the executor,
    // not the content script (the page has no access to request/response data).
    // Not retried — like other assertions, a miss is a real failure.
    if (isNetworkAssertion(step)) {
      const r = evaluateNetworkAssertion(step, tabId);
      return {
        step,
        status: r.passed ? 'passed' : 'failed',
        duration: Date.now() - start,
        error: r.passed ? undefined : r.error,
      };
    }

    // Step-level retry for transient failures. Assertion failures are NOT
    // retried — they indicate a real test issue.
    let lastResult: StepResult | undefined;
    for (let attempt = 0; attempt <= STEP_RETRY_ATTEMPTS; attempt++) {
      // A debugger session is now required: with the content-script execution
      // path removed (fix.md §3), no session means no execution at all. Failing
      // loudly beats silently doing nothing and reporting a pass.
      if (!canExecuteStep(tabId)) {
        lastResult = {
          step,
          status: 'failed',
          duration: Date.now() - start,
          error:
            'No CDP session on this tab. Pathfinder needs the debugger attached to ' +
            'execute steps — the page may be restricted (chrome://, Web Store) or the ' +
            'session was detached.',
        };
        if (attempt < STEP_RETRY_ATTEMPTS) {
          log.debug(`No CDP session, retrying step (attempt ${attempt + 1})`);
          await delay(STEP_RETRY_DELAY_MS * Math.pow(1.5, attempt));
          continue;
        }
        return lastResult;
      }

      const response = await executeStep(
        { ...step, timeout: step.timeout ?? DEFAULT_TIMEOUT },
        tabId
      );

      const success = response?.success ?? false;
      const error = response?.error;

      if (success) {
        return { step, status: 'passed', duration: Date.now() - start };
      }

      lastResult = { step, status: 'failed', duration: Date.now() - start, error };

      // Don't retry assertion failures — they're real test failures, not flakes
      if (step.action === 'assert') return lastResult;

      // Retry on transient errors
      const isTransient = error && (
        error.includes('timeout') || error.includes('Timeout') ||
        error.includes('unavailable') || error.includes('not found')
      );
      if (isTransient && attempt < STEP_RETRY_ATTEMPTS) {
        log.debug(`Step "${step.description}" failed with transient error, retrying (attempt ${attempt + 1}): ${error}`);
        await delay(STEP_RETRY_DELAY_MS * Math.pow(1.5, attempt));
        continue;
      }

      return lastResult;
    }

    return lastResult ?? { step, status: 'failed', duration: Date.now() - start, error: 'Exhausted retries' };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error(`Step failed: ${step.description}`, err);
    return {
      step,
      status: 'failed',
      duration: Date.now() - start,
      error,
    };
  }
}

/**
 * After navigation completes, wait for the page to settle.
 *
 * Reduced to the CDP network-idle signal only (fix.md §3). The content-script
 * ping-then-WAIT_FOR_IDLE round trip it used to do is gone: every subsequent
 * action asserts its own actionability preconditions in the driver (§8), so
 * there is nothing left for a post-navigate wait to protect against. What
 * remains is a courtesy settle that keeps the first action from racing the
 * initial burst of XHRs.
 */
async function waitForPageReady(tabId: number): Promise<void> {
  if (isAttached(tabId)) {
    await waitForNetworkIdle(tabId, { idleMs: 350, timeoutMs: POST_NAVIGATE_MAX_MS });
    return;
  }
  await delay(POST_NAVIGATE_MIN_MS);
}

/**
 * Navigate a tab to a URL and wait for it to fully load.
 * Properly cleans up the onUpdated listener to prevent leaks.
 */
export async function navigateTab(tabId: number, url: string): Promise<void> {
  if (!url) throw new Error('navigate action requires a value (URL)');

  return new Promise((resolve, reject) => {
    let resolved = false;

    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`Navigation timeout after ${NAVIGATE_TIMEOUT}ms: ${url}`));
    }, NAVIGATE_TIMEOUT);

    const listener = (
      updatedTabId: number,
      changeInfo: chrome.tabs.TabChangeInfo
    ) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        if (resolved) return;
        resolved = true;
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        // Poll for content script readiness with exponential backoff
        waitForPageReady(tabId).then(resolve).catch((err) => {
          log.warn('Page ready wait failed after navigation, proceeding anyway', err);
          resolve();
        });
      }
    };

    chrome.tabs.onUpdated.addListener(listener);

    chrome.tabs.update(tabId, { url }).catch((err) => {
      if (resolved) return;
      resolved = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
