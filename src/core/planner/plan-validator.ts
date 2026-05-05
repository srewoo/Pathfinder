/**
 * Plan Validator + Auto-Repair (Chrome Extension)
 *
 * After single-shot planning, this module checks that each step's selector
 * actually matches an element visible on the current page. For selectors that
 * fail, it tries semantic alternatives (aria-label, name, placeholder) and
 * replaces the broken selector before execution begins.
 *
 * Uses the DOM snapshot from the content script rather than Playwright locators.
 */

import type { ExecutionStep } from '../../storage/schemas';
import type { InteractiveElement } from '../../storage/schemas';
import { getPageSnapshot } from '../explorer/page-scanner';
import { sendToContentScript } from '../../messaging/messenger';
import { createLogger } from '../../utils/logger';

const log = createLogger('plan-validator');

export interface ValidationIssue {
  stepOrder: number;
  description: string;
  selector: string;
  fixedSelector?: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  repairedSteps: ExecutionStep[];
}

// Actions that don't need a DOM selector check
const SKIP_ACTIONS = new Set(['navigate', 'wait', 'press_key', 'dismiss_dialog', 'scroll']);

/**
 * Validate every selector in the plan against the current page snapshot.
 * Attempts auto-repair using semantic locators derived from step descriptions.
 */
export async function validateAndRepairPlan(
  tabId: number,
  steps: ExecutionStep[]
): Promise<ValidationResult> {
  const snapshot = await getPageSnapshot(tabId).catch(() => null);
  const elements: InteractiveElement[] = snapshot?.elements ?? [];

  const issues: ValidationIssue[] = [];
  const repairedSteps: ExecutionStep[] = [];

  for (const step of steps) {
    if (!step.selector || SKIP_ACTIONS.has(step.action)) {
      repairedSteps.push(step);
      continue;
    }

    // Check if any comma-separated fallback selector matches an element on the page.
    // First try a live DOM querySelector (most reliable), then fall back to snapshot matching.
    const primarySelectors = step.selector.split(',').map((s) => s.trim()).filter(Boolean);
    let resolves = false;

    // Live DOM validation: ask content script to run querySelector on live page
    try {
      const liveResult = await sendToContentScript<{ payload: boolean }>(tabId, {
        type: 'VALIDATE_SELECTORS',
        payload: { selectors: primarySelectors },
      });
      resolves = liveResult?.payload === true;
    } catch {
      // Content script might not support VALIDATE_SELECTORS yet — fall back to snapshot
      resolves = primarySelectors.some((sel) => selectorMatchesElement(sel, elements));
    }

    if (resolves) {
      repairedSteps.push(step);
      continue;
    }

    // Selector doesn't match — attempt semantic repair
    const fixedSelector = trySemanticRepair(step, elements);

    if (fixedSelector) {
      log.info(`Repaired step ${step.order}: "${step.selector}" → "${fixedSelector}" (${step.description.slice(0, 50)})`);
      repairedSteps.push({ ...step, selector: `${fixedSelector}, ${step.selector}` });
      issues.push({ stepOrder: step.order, description: step.description, selector: step.selector, fixedSelector });
    } else {
      log.warn(`Cannot resolve selector for step ${step.order}: "${step.selector}" (${step.description.slice(0, 50)})`);
      repairedSteps.push(step);
      issues.push({ stepOrder: step.order, description: step.description, selector: step.selector });
    }
  }

  const unrepairedCount = issues.filter((i) => !i.fixedSelector).length;
  if (issues.length > 0) {
    log.info(`Plan validation: ${issues.length} issues (${issues.length - unrepairedCount} repaired, ${unrepairedCount} unresolved)`);
  }

  return {
    valid: unrepairedCount === 0,
    issues,
    repairedSteps,
  };
}

// ─── Selector matching ────────────────────────────────────────────────────────

/**
 * Check if a CSS selector string plausibly matches any element in the snapshot.
 * This is approximate (no live DOM query) but catches the most common issues.
 */
function selectorMatchesElement(selector: string, elements: InteractiveElement[]): boolean {
  if (elements.length === 0) return true; // no snapshot — assume it's fine
  return elements.some((el) => {
    // Direct selector match
    if (el.selector === selector) return true;
    // ID selector match
    if (selector.startsWith('#') && el.selector.includes(selector)) return true;
    // data-testid match
    const testIdMatch = selector.match(/\[data-testid[*^$]?=["']?([^"'\]]+)["']?\]/);
    if (testIdMatch && el.testId === testIdMatch[1]) return true;
    // aria-label match
    const ariaMatch = selector.match(/\[aria-label[*^$]?=["']?([^"'\]]+)["']?\]/i);
    if (ariaMatch && el.ariaLabel?.toLowerCase().includes(ariaMatch[1].toLowerCase())) return true;
    // name attribute match
    const nameMatch = selector.match(/\[name=["']?([^"'\]]+)["']?\]/);
    if (nameMatch && el.name === nameMatch[1]) return true;
    return false;
  });
}

// ─── Semantic Repair ──────────────────────────────────────────────────────────

/**
 * Try to find a working selector from the page snapshot based on label hints
 * extracted from the step description.
 */
function trySemanticRepair(step: ExecutionStep, elements: InteractiveElement[]): string | undefined {
  if (elements.length === 0) return undefined;

  const hints = extractLabelHints(step.description);

  for (const hint of hints) {
    const lower = hint.toLowerCase();

    // Check ariaLabel match
    const byAria = elements.find(
      (el) => el.ariaLabel?.toLowerCase().includes(lower) && el.visible
    );
    if (byAria) return `[aria-label="${byAria.ariaLabel}"]`;

    // Check text match
    const byText = elements.find(
      (el) => el.text?.toLowerCase().includes(lower) && el.visible &&
        (el.tag === 'button' || el.tag === 'a' || el.role === 'button')
    );
    if (byText?.testId) return `[data-testid="${byText.testId}"]`;
    if (byText?.selector) return byText.selector;

    // Check testId match
    const byTestId = elements.find(
      (el) => el.testId?.toLowerCase().includes(lower) && el.visible
    );
    if (byTestId) return `[data-testid="${byTestId.testId}"]`;

    // Check name attribute match
    const byName = elements.find(
      (el) => el.name?.toLowerCase().includes(lower) && el.visible
    );
    if (byName) return `[name="${byName.name}"]`;

    // Check role match
    const byRole = elements.find(
      (el) => el.role?.toLowerCase().includes(lower) && el.visible
    );
    if (byRole?.selector) return byRole.selector;

    // Check placeholder match (for input fields)
    const byPlaceholder = elements.find(
      (el) => {
        const placeholder = (el as unknown as Record<string, unknown>).placeholder;
        return placeholder && String(placeholder).toLowerCase().includes(lower) && el.visible;
      }
    );
    if (byPlaceholder?.selector) return byPlaceholder.selector;
  }

  return undefined;
}

function extractLabelHints(description: string): string[] {
  const hints: string[] = [];

  // Quoted strings: 'Room name', "Submit"
  const quoted = description.match(/["']([^"']{2,40})["']/g) ?? [];
  hints.push(...quoted.map((q) => q.slice(1, -1)));

  // "the X field/button/input/link" pattern
  const fieldMatch = description.match(
    /(?:the\s+)?([A-Z][a-zA-Z0-9\s]{1,30}?)\s+(?:field|button|input|link|tab|checkbox|dropdown|icon|label)/gi
  );
  if (fieldMatch) {
    hints.push(
      ...fieldMatch.map((m) =>
        m.replace(/\s*(field|button|input|link|tab|checkbox|dropdown|icon|label)\s*$/i, '')
          .replace(/^the\s+/i, '').trim()
      )
    );
  }

  // Capitalised word sequences (likely UI labels)
  const caps = description.match(/\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*)\b/g) ?? [];
  hints.push(...caps.filter((c) => c.length > 2 && !COMMON_WORDS.has(c.toLowerCase())));

  return [...new Set(hints)].filter((h) => h.length >= 2 && h.length <= 50);
}

const COMMON_WORDS = new Set([
  'click', 'type', 'assert', 'verify', 'navigate', 'wait', 'scroll',
  'enter', 'open', 'close', 'submit', 'check', 'uncheck', 'select',
  'the', 'and', 'for', 'with', 'into', 'that', 'this', 'step', 'page',
]);
