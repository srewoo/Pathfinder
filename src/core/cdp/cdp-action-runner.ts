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
  dispatchKeyDownRaw,
  dispatchKeyUpRaw,
  dispatchHover,
  getElementState,
  evaluate,
  enableDialogAutoDismiss,
  registerDialogHandler,
  unregisterDialogHandler,
  startHARCapture,
  stopHARCapture,
  getHAREntries,
  getAccessibilityTree,
  serializeAXTree,
  DEEP_QUERY_FN,
  CDP_MODIFIERS,
} from './cdp-client';
import type { HAREntry, ElementState } from './cdp-client';
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

const ACTIONABILITY_TIMEOUT_MS = 5000;
const ACTIONABILITY_POLL_MS = 100;

/**
 * Auto-wait for an element (first of comma-separated fallbacks) to become
 * actionable: present, visible, enabled, and geometrically stable (its center
 * unchanged across two consecutive polls). This is the reliability primitive
 * that replaces blind fixed sleeps — we never dispatch a trusted event at an
 * element that is hidden, disabled, mid-animation, or off-screen.
 *
 * Returns the resolved selector + settled state, or null on timeout.
 */
async function waitForActionable(
  selectorStr: string,
  tabId: number,
  timeoutMs = ACTIONABILITY_TIMEOUT_MS
): Promise<{ selector: string; state: ElementState } | null> {
  const selectors = selectorStr.split(',').map((s) => s.trim()).filter(Boolean);
  const deadline = Date.now() + timeoutMs;
  let prev: ElementState | null = null;

  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const state = await getElementState(tabId, sel);
      if (state.found && state.visible && state.enabled && state.rect) {
        // Require geometric stability: same center as the previous poll.
        if (
          prev?.rect &&
          Math.abs(prev.rect.x - state.rect.x) < 1 &&
          Math.abs(prev.rect.y - state.rect.y) < 1
        ) {
          return { selector: sel, state };
        }
        prev = state;
      }
    }
    await delay(ACTIONABILITY_POLL_MS);
  }
  return null;
}

async function cdpClick(step: ExecutionStep, tabId: number, start: number): Promise<StepResult> {
  // Scroll the candidate into view, then auto-wait for actionability.
  await evaluate(tabId, `(() => { ${DEEP_QUERY_FN} const el = __deepQuery(document, ${JSON.stringify(step.selector!)}); if (el) el.scrollIntoView({ block: 'center' }); })()`);

  const target = await waitForActionable(step.selector!, tabId);
  if (!target) {
    // Not found / never became visible+enabled+stable — hand off to synthetic
    // (which has its own retry + healing) rather than clicking blind.
    return fallbackResult(step, tabId, start, 'Element not actionable within timeout for CDP click');
  }

  await dispatchClick(tabId, target.state.rect!.x, target.state.rect!.y);

  if (step.action === 'double_click') {
    await delay(50);
    await dispatchClick(tabId, target.state.rect!.x, target.state.rect!.y);
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
  const target = await waitForActionable(step.selector!, tabId);
  if (!target) {
    return fallbackResult(step, tabId, start, 'Element not actionable within timeout for CDP type');
  }
  const sel = target.selector;

  // Focus the element (shadow-DOM aware)
  await evaluate(tabId, `(() => { ${DEEP_QUERY_FN} const el = __deepQuery(document, ${JSON.stringify(sel)}); if (el) { el.focus(); el.scrollIntoView({ block: 'center' }); } })()`);
  await delay(100);

  // Clear existing content
  await dispatchKeyPress(tabId, 'a', undefined, CDP_MODIFIERS.Control);
  await evaluate(tabId, `(() => {
    ${DEEP_QUERY_FN}
    const el = __deepQuery(document, ${JSON.stringify(sel)});
    if (el) {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        'value'
      )?.set;
      if (nativeSetter) nativeSetter.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  })()`);
  await delay(50);

  // Verify clear succeeded before typing. evaluate() already unwraps to the
  // raw returned value, so read it directly (not `.result.value`).
  try {
    const remaining = await evaluate<string>(tabId, `(() => {
      ${DEEP_QUERY_FN}
      const el = __deepQuery(document, ${JSON.stringify(sel)});
      return el ? (el.value ?? el.textContent ?? '') : '';
    })()`);
    if (typeof remaining === 'string' && remaining.length > 0) {
      log.warn(`Field clear may not have succeeded for "${sel}" (still "${remaining.slice(0, 20)}"), proceeding with type`);
    }
  } catch { /* non-fatal — proceed with typing regardless */ }

  // Type the text character by character via CDP trusted events
  await dispatchType(tabId, step.value ?? '');

  // Fire change event
  await evaluate(tabId, `(() => {
    ${DEEP_QUERY_FN}
    const el = __deepQuery(document, ${JSON.stringify(sel)});
    if (el) el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);

  await delay(100);

  // Verify the value actually landed — a type that leaves the field empty (or
  // unchanged for a non-empty target) is a real failure, not a pass.
  if (step.value) {
    try {
      const landed = await evaluate<string>(tabId, `(() => {
        ${DEEP_QUERY_FN}
        const el = __deepQuery(document, ${JSON.stringify(sel)});
        return el ? String(el.value ?? el.textContent ?? '') : '';
      })()`);
      if (typeof landed === 'string' && !landed.includes(step.value)) {
        return fallbackResult(step, tabId, start, `Typed value did not land (field is "${landed.slice(0, 30)}")`);
      }
    } catch { /* verification best-effort; don't fail on read error */ }
  }

  return {
    step,
    status: 'passed',
    duration: Date.now() - start,
  };
}

async function cdpClear(step: ExecutionStep, tabId: number, start: number): Promise<StepResult> {
  const cleared = await evaluate<boolean>(tabId, `(() => {
    ${DEEP_QUERY_FN}
    const el = __deepQuery(document, ${JSON.stringify(step.selector!)});
    if (!el) return false;
    el.focus();
    const nativeSetter = Object.getOwnPropertyDescriptor(
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      'value'
    )?.set;
    if (nativeSetter) nativeSetter.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);

  if (!cleared) {
    return fallbackResult(step, tabId, start, 'Element not found for CDP clear');
  }

  return {
    step,
    status: 'passed',
    duration: Date.now() - start,
  };
}

async function cdpPressKey(step: ExecutionStep, tabId: number, start: number): Promise<StepResult> {
  if (step.selector) {
    await evaluate(tabId, `(() => { ${DEEP_QUERY_FN} const el = __deepQuery(document, ${JSON.stringify(step.selector)}); if (el) el.focus(); })()`);
    await delay(100);
  }

  const key = step.key ?? 'Enter';
  const parts = key.split('+');
  const mainKey = parts.pop() ?? key;

  // Resolve modifiers to their held key name + cumulative CDP bitmask. The main
  // key must be dispatched WHILE the modifiers are held (with the bitmask set),
  // otherwise Ctrl+A degrades to a bare "a" — the previous code pressed AND
  // released each modifier before the main key and never set `modifiers`.
  const heldKeys: string[] = [];
  let modifierMask = 0;
  for (const mod of parts) {
    const m = mod.toLowerCase();
    if (m === 'ctrl' || m === 'control') { heldKeys.push('Control'); modifierMask |= CDP_MODIFIERS.Control; }
    else if (m === 'shift') { heldKeys.push('Shift'); modifierMask |= CDP_MODIFIERS.Shift; }
    else if (m === 'alt') { heldKeys.push('Alt'); modifierMask |= CDP_MODIFIERS.Alt; }
    else if (m === 'meta' || m === 'cmd' || m === 'command') { heldKeys.push('Meta'); modifierMask |= CDP_MODIFIERS.Meta; }
  }

  for (const held of heldKeys) {
    await dispatchKeyDownRaw(tabId, held, modifierMask);
  }
  try {
    await dispatchKeyPress(tabId, mainKey, undefined, modifierMask);
  } finally {
    // Release in reverse order regardless of outcome so modifiers never stick.
    for (const held of [...heldKeys].reverse()) {
      await dispatchKeyUpRaw(tabId, held, 0);
    }
  }

  await delay(100);

  return {
    step,
    status: 'passed',
    duration: Date.now() - start,
  };
}

async function cdpHover(step: ExecutionStep, tabId: number, start: number): Promise<StepResult> {
  await evaluate(tabId, `(() => { ${DEEP_QUERY_FN} const el = __deepQuery(document, ${JSON.stringify(step.selector!)}); if (el) el.scrollIntoView({ block: 'center' }); })()`);

  const target = await waitForActionable(step.selector!, tabId);
  if (!target) {
    return fallbackResult(step, tabId, start, 'Element not actionable within timeout for CDP hover');
  }

  await dispatchHover(tabId, target.state.rect!.x, target.state.rect!.y);
  await delay(200);

  return {
    step,
    status: 'passed',
    duration: Date.now() - start,
  };
}

async function cdpCheck(step: ExecutionStep, tabId: number, start: number): Promise<StepResult> {
  const checked = step.action === 'check';

  const result = await evaluate<boolean | null>(tabId, `(() => {
    ${DEEP_QUERY_FN}
    const el = __deepQuery(document, ${JSON.stringify(step.selector!)});
    if (!el) return null;
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
    if (nativeSetter) nativeSetter.call(el, ${checked});
    else el.checked = ${checked};
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.checked === ${checked};
  })()`);

  await delay(100);

  if (result === null) {
    return fallbackResult(step, tabId, start, 'Element not found for CDP check');
  }
  if (result === false) {
    return fallbackResult(step, tabId, start, `Checkbox did not reach checked=${checked}`);
  }

  return {
    step,
    status: 'passed',
    duration: Date.now() - start,
  };
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
