/**
 * CDP-enhanced action runner.
 *
 * Wraps the CDP client to provide high-level action dispatch using
 * trusted browser events. Falls back to content-script synthetic events
 * when CDP is unavailable (e.g., debugger detached by user).
 *
 * The executor can choose between CDP and synthetic dispatch per-step.
 */
import type { ExecutionStep, StepResult } from '../../storage/schemas';
import {
  attach,
  detach,
  isAttached,
  dispatchClick,
  dispatchType,
  dispatchKeyPress,
  dispatchHover,
  getElementBounds,
  evaluate,
  enableDialogAutoDismiss,
  registerDialogHandler,
  unregisterDialogHandler,
  startHARCapture,
  stopHARCapture,
  getHAREntries,
  getAccessibilityTree,
  serializeAXTree,
} from './cdp-client';
import type { HAREntry } from './cdp-client';
import { runStep as runSyntheticStep } from '../executor/action-runner';
import { createLogger } from '../../utils/logger';

const log = createLogger('cdp-action-runner');

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Initialize CDP for a test execution session:
 * - Attach debugger to tab
 * - Enable dialog auto-dismissal
 * - Start network HAR capture
 */
export async function initCDPSession(tabId: number): Promise<boolean> {
  try {
    await attach(tabId);
    await enableDialogAutoDismiss(tabId);
    registerDialogHandler(tabId);
    await startHARCapture(tabId);
    log.info(`CDP session initialized for tab ${tabId}`);
    return true;
  } catch (err) {
    log.warn(`CDP init failed for tab ${tabId}, will use synthetic events`, err);
    return false;
  }
}

/**
 * Tear down CDP session after test execution.
 * Returns captured HAR entries.
 */
export async function teardownCDPSession(tabId: number): Promise<HAREntry[]> {
  let harEntries: HAREntry[] = [];

  try {
    harEntries = await stopHARCapture(tabId);
  } catch {
    // Non-fatal
  }

  unregisterDialogHandler(tabId);

  try {
    await detach(tabId);
  } catch {
    // Non-fatal — tab may already be closed
  }

  return harEntries;
}

/**
 * Run a step using CDP trusted events when available.
 * Falls back to synthetic events if CDP is not attached or the action
 * is not supported via CDP.
 */
export async function runStepWithCDP(step: ExecutionStep, tabId: number): Promise<StepResult> {
  // Actions that are always handled outside CDP
  if (step.action === 'navigate' || step.action === 'assert' || step.action === 'wait' ||
      step.action === 'scroll' || step.action === 'dismiss_dialog' || step.action === 'upload_file') {
    return runSyntheticStep(step, tabId);
  }

  // If CDP is not attached, use synthetic events
  if (!isAttached(tabId)) {
    return runSyntheticStep(step, tabId);
  }

  const start = Date.now();

  try {
    switch (step.action) {
      case 'click':
      case 'double_click':
        return await cdpClick(step, tabId, start);

      case 'type':
        return await cdpType(step, tabId, start);

      case 'clear':
        return await cdpClear(step, tabId, start);

      case 'press_key':
        return await cdpPressKey(step, tabId, start);

      case 'hover':
        return await cdpHover(step, tabId, start);

      case 'check':
      case 'uncheck':
        return await cdpCheck(step, tabId, start);

      case 'select':
        // Custom dropdowns are complex — fall back to synthetic events
        return runSyntheticStep(step, tabId);

      case 'drag_drop':
        // Drag and drop requires complex event sequencing — fall back
        return runSyntheticStep(step, tabId);

      default:
        return runSyntheticStep(step, tabId);
    }
  } catch (err) {
    log.warn(`CDP action failed for ${step.action}, falling back to synthetic`, err);
    // Fall back to synthetic events on CDP failure
    return runSyntheticStep(step, tabId);
  }
}

// ── CDP Action Implementations ──────────────────────────────────────────────

async function cdpClick(step: ExecutionStep, tabId: number, start: number): Promise<StepResult> {
  const bounds = await resolveSelector(step.selector!, tabId);
  if (!bounds) {
    return fallbackResult(step, tabId, start, 'Element not found for CDP click');
  }

  // Scroll element into view first
  await evaluate(tabId, `document.querySelector(${JSON.stringify(step.selector!)})?.scrollIntoView({ block: 'center' })`);

  // Wait for element to be in viewport (poll up to 500ms instead of fixed delay)
  let freshBounds = await getElementBounds(tabId, step.selector!);
  for (let wait = 0; !freshBounds && wait < 500; wait += 100) {
    await delay(100);
    freshBounds = await getElementBounds(tabId, step.selector!);
  }
  if (!freshBounds) {
    return fallbackResult(step, tabId, start, 'Element lost after scroll');
  }

  await dispatchClick(tabId, freshBounds.x, freshBounds.y);

  if (step.action === 'double_click') {
    await delay(50);
    await dispatchClick(tabId, freshBounds.x, freshBounds.y);
  }

  // Brief wait for DOM to settle
  await delay(200);

  return {
    step,
    status: 'passed',
    duration: Date.now() - start,
  };
}

async function cdpType(step: ExecutionStep, tabId: number, start: number): Promise<StepResult> {
  const bounds = await resolveSelector(step.selector!, tabId);
  if (!bounds) {
    return fallbackResult(step, tabId, start, 'Element not found for CDP type');
  }

  // Focus the element
  await evaluate(tabId, `
    const el = document.querySelector(${JSON.stringify(step.selector!)});
    if (el) { el.focus(); el.scrollIntoView({ block: 'center' }); }
  `);
  await delay(100);

  // Clear existing content
  await dispatchKeyPress(tabId, 'a', undefined);
  await evaluate(tabId, `
    const el = document.querySelector(${JSON.stringify(step.selector!)});
    if (el) {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        'value'
      )?.set;
      if (nativeSetter) nativeSetter.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  `);
  await delay(50);

  // Verify clear succeeded before typing
  try {
    const clearCheck = await evaluate(tabId, `
      (() => { const el = document.querySelector(${JSON.stringify(step.selector!)}); return el ? (el.value ?? el.textContent ?? '') : ''; })()
    `);
    const val = clearCheck as unknown as { result?: { value?: string } };
    if (val?.result?.value && val.result.value.length > 0) {
      log.warn(`Field clear may not have succeeded for "${step.selector}", proceeding with type`);
    }
  } catch { /* non-fatal — proceed with typing regardless */ }

  // Type the text character by character via CDP trusted events
  await dispatchType(tabId, step.value ?? '');

  // Fire change event
  await evaluate(tabId, `
    const el = document.querySelector(${JSON.stringify(step.selector!)});
    if (el) {
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  `);

  await delay(100);

  return {
    step,
    status: 'passed',
    duration: Date.now() - start,
  };
}

async function cdpClear(step: ExecutionStep, tabId: number, start: number): Promise<StepResult> {
  await evaluate(tabId, `
    const el = document.querySelector(${JSON.stringify(step.selector!)});
    if (el) {
      el.focus();
      const nativeSetter = Object.getOwnPropertyDescriptor(
        el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        'value'
      )?.set;
      if (nativeSetter) nativeSetter.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  `);

  return {
    step,
    status: 'passed',
    duration: Date.now() - start,
  };
}

async function cdpPressKey(step: ExecutionStep, tabId: number, start: number): Promise<StepResult> {
  if (step.selector) {
    await evaluate(tabId, `document.querySelector(${JSON.stringify(step.selector)})?.focus()`);
    await delay(100);
  }

  const key = step.key ?? 'Enter';
  const parts = key.split('+');
  const mainKey = parts.pop() ?? key;

  // Handle modifiers
  for (const mod of parts) {
    const modKey = mod.toLowerCase() === 'ctrl' || mod.toLowerCase() === 'control' ? 'Control'
      : mod.toLowerCase() === 'shift' ? 'Shift'
      : mod.toLowerCase() === 'alt' ? 'Alt'
      : mod.toLowerCase() === 'meta' || mod.toLowerCase() === 'cmd' ? 'Meta'
      : mod;
    await dispatchKeyPress(tabId, modKey);
  }

  await dispatchKeyPress(tabId, mainKey);

  await delay(100);

  return {
    step,
    status: 'passed',
    duration: Date.now() - start,
  };
}

async function cdpHover(step: ExecutionStep, tabId: number, start: number): Promise<StepResult> {
  const bounds = await resolveSelector(step.selector!, tabId);
  if (!bounds) {
    return fallbackResult(step, tabId, start, 'Element not found for CDP hover');
  }

  await evaluate(tabId, `document.querySelector(${JSON.stringify(step.selector!)})?.scrollIntoView({ block: 'center' })`);
  await delay(100);

  const freshBounds = await getElementBounds(tabId, step.selector!);
  if (!freshBounds) {
    return fallbackResult(step, tabId, start, 'Element lost after scroll');
  }

  await dispatchHover(tabId, freshBounds.x, freshBounds.y);
  await delay(200);

  return {
    step,
    status: 'passed',
    duration: Date.now() - start,
  };
}

async function cdpCheck(step: ExecutionStep, tabId: number, start: number): Promise<StepResult> {
  const checked = step.action === 'check';

  await evaluate(tabId, `
    const el = document.querySelector(${JSON.stringify(step.selector!)});
    if (el) {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
      if (nativeSetter) nativeSetter.call(el, ${checked});
      else el.checked = ${checked};
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  `);

  await delay(100);

  return {
    step,
    status: 'passed',
    duration: Date.now() - start,
  };
}

// ── Selector Resolution with Fallbacks ──────────────────────────────────────

/**
 * Try to resolve a selector, supporting comma-separated fallback selectors.
 * Returns the bounds of the first matching selector.
 */
async function resolveSelector(
  selectorStr: string,
  tabId: number
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const selectors = selectorStr.split(',').map((s) => s.trim()).filter(Boolean);

  for (const sel of selectors) {
    const bounds = await getElementBounds(tabId, sel);
    if (bounds) return bounds;
  }
  return null;
}

/**
 * Fall back to synthetic step execution.
 */
async function fallbackResult(step: ExecutionStep, tabId: number, _start: number, reason: string): Promise<StepResult> {
  log.info(`CDP fallback for ${step.description}: ${reason}`);
  return runSyntheticStep(step, tabId);
}

// ── Exported Context Helpers ────────────────────────────────────────────────

/**
 * Get the serialized accessibility tree for AI planning context.
 */
export async function getAXContext(tabId: number): Promise<string> {
  if (!isAttached(tabId)) return '';
  const nodes = await getAccessibilityTree(tabId);
  return serializeAXTree(nodes);
}

/**
 * Get captured network HAR entries for the current session.
 */
export function getCurrentHAR(tabId: number): HAREntry[] {
  return getHAREntries(tabId);
}

/**
 * Re-export CDP full-page screenshot capability.
 */
export { captureFullPageScreenshot } from './cdp-client';

// ── Helpers ─────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
