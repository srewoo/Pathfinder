/**
 * Extended step types: conditionals, loops, and data capture/substitution.
 *
 * These action types allow richer test flows:
 * - if_visible: run a step only when a selector is visible (dismiss modal, handle optional UI)
 * - loop: repeat steps N times (add N items to cart, fill N rows)
 * - capture_value: capture text/value from an element into a named variable
 * - use_captured: substitute a captured variable into another step's value
 */
import type { ExecutionStep, StepResult } from '../../storage/schemas';
import { runStep } from './action-runner';
import { createLogger } from '../../utils/logger';

const log = createLogger('step-extensions');

// ---------------------------------------------------------------------------
// Conditional: if_visible
// ---------------------------------------------------------------------------

/**
 * Execute a conditional step. If the selector is visible on the page,
 * execute the `thenStep`; otherwise execute the `elseStep` (if provided).
 */
export async function executeConditionalStep(
  step: ExecutionStep,
  tabId: number,
  capturedValues: Map<string, string>,
  stepRunner: typeof runStep
): Promise<StepResult> {
  if (!step.selector) {
    return { step, status: 'passed', duration: 0 };
  }

  const isVisible = await checkElementVisible(tabId, step.selector);

  if (isVisible && step.thenStep) {
    log.info(`Condition met (${step.selector} visible) — executing thenStep`);
    const resolved = resolveStepVariables(step.thenStep, capturedValues);
    return await stepRunner(resolved, tabId);
  }

  if (!isVisible && step.elseStep) {
    log.info(`Condition not met (${step.selector} not visible) — executing elseStep`);
    const resolved = resolveStepVariables(step.elseStep, capturedValues);
    return await stepRunner(resolved, tabId);
  }

  // No action needed — condition not met and no else branch
  return { step, status: 'passed', duration: 0 };
}

// ---------------------------------------------------------------------------
// Loop: repeat steps N times
// ---------------------------------------------------------------------------

/**
 * Execute a loop step — repeats `loopSteps` for `loopCount` iterations.
 * Loop index is available as {{loop_index}} in step values (0-based).
 */
export async function executeLoopStep(
  step: ExecutionStep,
  tabId: number,
  capturedValues: Map<string, string>,
  stepRunner: typeof runStep
): Promise<StepResult> {
  const count = step.loopCount ?? 1;
  const steps = step.loopSteps ?? [];

  if (steps.length === 0) {
    return { step, status: 'passed', duration: 0 };
  }

  log.info(`Starting loop: ${count} iterations × ${steps.length} steps`);

  for (let i = 0; i < count; i++) {
    capturedValues.set('loop_index', String(i));
    capturedValues.set('loop_iteration', String(i + 1));

    for (const innerStep of steps) {
      const resolved = resolveStepVariables(innerStep, capturedValues);
      const result = await stepRunner(resolved, tabId);

      if (result.status === 'failed') {
        log.warn(`Loop iteration ${i + 1} step failed: ${result.error}`);
        return { step, status: 'failed', duration: 0, error: `Loop iteration ${i + 1}: ${result.error}` };
      }

      await delay(200);
    }
  }

  capturedValues.delete('loop_index');
  capturedValues.delete('loop_iteration');

  return { step, status: 'passed', duration: 0 };
}

// ---------------------------------------------------------------------------
// Capture Value: extract text/value from DOM element
// ---------------------------------------------------------------------------

/**
 * Capture a value from a DOM element and store it in the capturedValues map.
 * Supports capturing: text content, input value, or attribute value.
 */
export async function executeCaptureValue(
  step: ExecutionStep,
  tabId: number,
  capturedValues: Map<string, string>
): Promise<StepResult> {
  if (!step.selector || !step.captureName) {
    return { step, status: 'failed', duration: 0, error: 'capture_value requires selector and captureName' };
  }

  const source = step.captureSource ?? 'text';
  const attribute = step.attribute;

  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel: string, src: string, attr: string | undefined) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        if (src === 'value') return (el as HTMLInputElement).value ?? '';
        if (src === 'attribute' && attr) return el.getAttribute(attr) ?? '';
        return el.textContent?.trim() ?? '';
      },
      args: [step.selector, source, attribute],
    });

    const value = result?.result;
    if (value === null || value === undefined) {
      return { step, status: 'failed', duration: 0, error: `Element not found: ${step.selector}` };
    }

    capturedValues.set(step.captureName, String(value));
    log.info(`Captured "${step.captureName}" = "${String(value).slice(0, 50)}"`);
    return { step, status: 'passed', duration: 0 };
  } catch (err) {
    return { step, status: 'failed', duration: 0, error: `capture_value failed: ${err}` };
  }
}

// ---------------------------------------------------------------------------
// Variable Resolution: substitute {{varName}} in step values
// ---------------------------------------------------------------------------

/**
 * Replace `{{variableName}}` placeholders in step value and assertExpected
 * with values from the captured map.
 */
export function resolveStepVariables(step: ExecutionStep, capturedValues: Map<string, string>): ExecutionStep {
  if (capturedValues.size === 0) return step;

  let modified = false;
  let value = step.value;
  let assertExpected = step.assertExpected;

  if (value) {
    const resolved = substituteVariables(value, capturedValues);
    if (resolved !== value) { value = resolved; modified = true; }
  }

  if (assertExpected) {
    const resolved = substituteVariables(assertExpected, capturedValues);
    if (resolved !== assertExpected) { assertExpected = resolved; modified = true; }
  }

  return modified ? { ...step, value, assertExpected } : step;
}

function substituteVariables(text: string, vars: Map<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, name) => {
    return vars.get(name) ?? match;
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function checkElementVisible(tabId: number, selector: string): Promise<boolean> {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0
          && style.visibility !== 'hidden'
          && style.display !== 'none'
          && style.opacity !== '0'
          && style.pointerEvents !== 'none';
      },
      args: [selector],
    });
    return result?.result ?? false;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
