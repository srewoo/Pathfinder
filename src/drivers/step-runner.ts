/**
 * Legacy-step runner over the CDP driver (fix.md §3).
 *
 * The single execution substrate. This is the drop-in replacement for
 * `sendToContentScript({ type: 'EXECUTE_ACTION' })`: same call shape
 * (`{ success, error }`), CDP underneath instead of synthetic DOM events.
 *
 * It exists so the ~11 legacy call sites could migrate without each one being
 * rewritten around `TestIR` first. New code should prefer `ir-executor.ts`; this
 * is the bridge that let `content/dom-actions.ts` be deleted, and it will shrink
 * as call sites move to IR.
 *
 * Actions dispatch through the driver, so they inherit §8's actionability
 * preconditions automatically — no call site waits any more. Assertions poll
 * page-side, preserving the original semantics (see `assert-scripts.ts`).
 */
import type { ExecutionStep } from '../storage/schemas';
import type { Driver } from '../core/driver';
import { fromCss, type Locator } from '../core/locator';
import { createCdpDriver } from './cdp-driver';
import { isAttached } from '../core/cdp/cdp-client';
import { assertExpr, animationSettleExpr, type AssertOutcome } from './assert-scripts';
import { registerStepExecutor } from '../core/step-executor';
import { createLogger } from '../utils/logger';

const log = createLogger('step-runner');

export interface StepOutcome {
  success: boolean;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const ASSERT_POLL_MS = 150;

/**
 * One driver per tab, reused across steps.
 *
 * Recreating a driver per step would re-tag every element with a fresh
 * `data-pf-ref` and lose the CDP session's warm state. Entries are dropped on
 * `releaseDriver` so a closed tab does not leak (CLAUDE.md §11.1).
 */
const drivers = new Map<number, Driver>();

export function driverForTab(tabId: number): Driver {
  const existing = drivers.get(tabId);
  if (existing) return existing;
  const driver = createCdpDriver({ tabId });
  drivers.set(tabId, driver);
  return driver;
}

export function releaseDriver(tabId: number): void {
  drivers.delete(tabId);
}

/** Test seam: inject a fake driver for a tab id. */
export function setDriverForTab(tabId: number, driver: Driver): void {
  drivers.set(tabId, driver);
}

/**
 * Execute a legacy `ExecutionStep`.
 *
 * Never throws — returns `{ success: false, error }` so every existing call site
 * keeps behaving the way it did when the content script answered.
 */
export async function executeStepViaDriver(
  step: ExecutionStep,
  tabId: number
): Promise<StepOutcome> {
  const driver = driverForTab(tabId);
  const timeoutMs = step.timeout ?? DEFAULT_TIMEOUT_MS;

  try {
    if (step.action === 'assert') {
      return await runAssertion(driver, step, timeoutMs);
    }

    const locator = step.selector ? fromCss(step.selector, step.description) : undefined;

    switch (step.action) {
      case 'navigate':
        if (!step.value) return fail('navigate action requires a value (URL)');
        await driver.navigate(step.value);
        return ok();

      case 'click':
      case 'double_click':
        await driver.click(need(locator, step), {
          double: step.action === 'double_click',
          timeoutMs,
        });
        return ok();

      case 'type':
        await driver.type(need(locator, step), step.value ?? '', { timeoutMs });
        return ok();

      case 'clear':
        await driver.clear(need(locator, step), { timeoutMs });
        return ok();

      case 'hover':
        await driver.hover(need(locator, step), { timeoutMs });
        return ok();

      case 'check':
      case 'uncheck':
        await driver.setChecked(need(locator, step), step.action === 'check', { timeoutMs });
        return ok();

      case 'select':
        await driver.selectOption(need(locator, step), step.value ?? '', { timeoutMs });
        return ok();

      case 'press_key':
        await driver.pressKey(step.key ?? step.value ?? 'Enter', locator, { timeoutMs });
        return ok();

      case 'drag_drop': {
        if (!step.targetSelector) return fail('drag_drop action requires a targetSelector');
        await driver.dragDrop(need(locator, step), fromCss(step.targetSelector), { timeoutMs });
        return ok();
      }

      case 'upload_file': {
        const files = (step.value ?? '').split(',').map((f) => f.trim()).filter(Boolean);
        if (files.length === 0) return fail('upload_file action requires a value (file name)');
        await driver.uploadFile(need(locator, step), files, { timeoutMs });
        return ok();
      }

      case 'scroll':
        await driver.scroll(
          locator
            ? { locator }
            : step.value === 'top' || step.value === 'bottom'
              ? { to: step.value }
              : { px: Number(step.value ?? 0) }
        );
        return ok();

      case 'wait':
        // §8 removed waiting as an authored concern: actions assert their own
        // preconditions. A `wait` step is honoured as a no-op rather than an
        // error so legacy plans still run, but it does nothing and should be
        // dropped from any regenerated plan.
        log.debug(`Ignoring legacy 'wait' step — actionability is handled by the driver`);
        return ok();

      case 'dismiss_dialog':
        // Dialogs are auto-dismissed for the whole session at driver open; there
        // is nothing per-step to do.
        await driver.autoDismissDialogs(true);
        return ok();

      case 'capture_value':
      case 'use_captured':
      case 'if_visible':
      case 'loop':
        // Composite actions are expanded by `executor/step-extensions.ts` before
        // dispatch. Reaching here means the caller skipped that expansion.
        return fail(
          `Action "${step.action}" must be expanded by step-extensions before dispatch`
        );

      default:
        return fail(`Unsupported action: ${String(step.action)}`);
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { success: false, error };
  }
}

// ── Assertions ──────────────────────────────────────────────────────────────

/**
 * Poll the assertion until it passes or the deadline expires.
 *
 * Polling (rather than a single check) is deliberate and was the old behaviour:
 * an assertion is a question about a state the app may still be reaching, and a
 * one-shot check turns every async update into a flake.
 */
async function runAssertion(
  driver: Driver,
  step: ExecutionStep,
  timeoutMs: number
): Promise<StepOutcome> {
  const deadline = Date.now() + timeoutMs;
  const expression = assertExpr(step);

  // Let transitions settle first for visibility assertions — checking an element
  // mid-animation (opacity 0→1) reports a false negative.
  if ((step.assertType === 'visible' || step.assertType === 'not_visible') && step.selector) {
    try {
      const settleMs = await driver.evaluate<number>(
        animationSettleExpr(step.selector, Math.min(1000, timeoutMs))
      );
      if (typeof settleMs === 'number' && settleMs > 0) await delay(settleMs);
    } catch {
      // Best effort — a failed settle probe must not fail the assertion.
    }
  }

  let last: AssertOutcome = { success: false, error: 'Assertion never evaluated' };

  for (;;) {
    try {
      const result = await driver.evaluate<AssertOutcome>(expression);
      if (result?.success) return ok();
      if (result) last = result;
    } catch (err) {
      last = { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    if (Date.now() >= deadline) return { success: false, error: last.error };
    await delay(ASSERT_POLL_MS);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function need(locator: Locator | undefined, step: ExecutionStep): Locator {
  if (!locator) throw new Error(`Action "${step.action}" requires a selector`);
  return locator;
}

function ok(): StepOutcome {
  return { success: true };
}

function fail(error: string): StepOutcome {
  return { success: false, error };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Whether a CDP session is live for this tab.
 *
 * Callers use this to fail loudly instead of silently doing nothing: with the
 * content-script path gone, no debugger session means no execution at all.
 */
export function canExecute(tabId: number): boolean {
  return isAttached(tabId);
}

// Register with the core port so `src/core` never imports this module directly
// (fix.md §2). Importing this file for its side effect is intentional and done
// once, from the service worker.
registerStepExecutor(executeStepViaDriver, canExecute, releaseDriver);
