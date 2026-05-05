import type { ExecutionStep, StepResult } from '../../storage/schemas';
import { sendToContentScript, pingContentScript } from '../../messaging/messenger';
import { createLogger } from '../../utils/logger';

const log = createLogger('action-runner');

const DEFAULT_TIMEOUT = 15000;
const NAVIGATE_TIMEOUT = 20000;
const POST_NAVIGATE_MIN_MS = 500;
const POST_NAVIGATE_MAX_MS = 8000;
const CONTENT_SCRIPT_RETRY_ATTEMPTS = 3;
const CONTENT_SCRIPT_RETRY_DELAY_MS = 800;
/** Max step-level retries for transient failures (timeout, content script flake). */
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

    // Step-level retry for transient failures (timeout, content script flakes).
    // Assertion failures are NOT retried — they indicate a real test issue.
    let lastResult: StepResult | undefined;
    for (let attempt = 0; attempt <= STEP_RETRY_ATTEMPTS; attempt++) {
      // Ensure content script is alive before sending
      const ready = await waitForContentScript(tabId);
      if (!ready) {
        lastResult = {
          step,
          status: 'failed',
          duration: Date.now() - start,
          error: 'Content script unavailable. The page may be loading or restricted.',
        };
        if (attempt < STEP_RETRY_ATTEMPTS) {
          log.debug(`Content script unavailable, retrying step (attempt ${attempt + 1})`);
          await delay(STEP_RETRY_DELAY_MS * Math.pow(1.5, attempt));
          continue;
        }
        return lastResult;
      }

      const response = await sendToContentScript<{ success: boolean; error?: string }>(
        tabId,
        {
          type: 'EXECUTE_ACTION',
          payload: {
            ...step,
            timeout: step.timeout ?? DEFAULT_TIMEOUT,
          },
        }
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
 * After navigation completes, wait for the content script to be ready
 * AND for the page to settle (DOM idle + network idle).
 * Uses exponential backoff polling instead of a fixed delay.
 */
async function waitForPageReady(tabId: number): Promise<void> {
  const start = Date.now();

  // First wait a minimum amount for scripts to begin executing
  await delay(POST_NAVIGATE_MIN_MS);

  // Then poll for content script availability with backoff
  let backoff = 200;
  while (Date.now() - start < POST_NAVIGATE_MAX_MS) {
    const alive = await pingContentScript(tabId);
    if (alive) {
      // Content script is alive — ask it to wait for DOM+network idle
      try {
        await sendToContentScript(tabId, { type: 'WAIT_FOR_IDLE', settleMs: 300 } as any, 3000);
      } catch {
        // Timeout is acceptable — page may be slow but content script is alive
      }
      return;
    }
    await delay(backoff);
    backoff = Math.min(backoff * 1.5, 1000);
  }
  // Exhausted wait time — proceed anyway
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

/**
 * Wait for the content script to become available after navigation.
 * Retries with backoff — the content script takes time to inject after load.
 */
async function waitForContentScript(tabId: number): Promise<boolean> {
  for (let i = 0; i < CONTENT_SCRIPT_RETRY_ATTEMPTS; i++) {
    const alive = await pingContentScript(tabId);
    if (alive) return true;
    if (i < CONTENT_SCRIPT_RETRY_ATTEMPTS - 1) {
      await delay(CONTENT_SCRIPT_RETRY_DELAY_MS * Math.pow(1.5, i));
    }
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
