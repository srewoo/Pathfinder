/**
 * Plan Validator + Auto-Repair
 *
 * After single-shot planning, this module checks that each step's selector
 * actually resolves on the current page. For selectors that fail, it tries
 * semantic alternatives (aria-label, placeholder, role+name) and replaces
 * the broken selector with a working one before execution begins.
 *
 * This catches the most common single-shot planning failure: the AI generates
 * a plausible-looking CSS selector that doesn't match the actual DOM.
 */

import type { Page } from 'playwright';
import type { ExecutionStep } from '../../storage/schemas.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('plan-validator');

export interface ValidationIssue {
  stepOrder: number;
  description: string;
  selector: string;
  fixedSelector?: string;
}

export interface ValidationResult {
  /** True if all selectors resolved (or were repaired). */
  valid: boolean;
  /** Issues found — includes both repaired and unresolvable selectors. */
  issues: ValidationIssue[];
  /** Steps with repaired selectors substituted in. */
  repairedSteps: ExecutionStep[];
}

// Actions that don't need a DOM selector check
const SKIP_ACTIONS = new Set(['navigate', 'wait', 'press_key', 'dismiss_dialog', 'switch_tab', 'scroll']);

/**
 * Validate every selector in the plan against the live page (which should be
 * at the test's start URL). Attempts auto-repair using semantic locators.
 *
 * Returns the full step list with any repaired selectors substituted in.
 */
export async function validateAndRepairPlan(
  page: Page,
  steps: ExecutionStep[]
): Promise<ValidationResult> {
  const issues: ValidationIssue[] = [];
  const repairedSteps: ExecutionStep[] = [];

  for (const step of steps) {
    if (!step.selector || SKIP_ACTIONS.has(step.action)) {
      repairedSteps.push(step);
      continue;
    }

    // CSS selectors can be comma-separated fallbacks — check if any resolves
    const primarySelectors = step.selector.split(',').map((s) => s.trim()).filter(Boolean);
    let resolves = false;

    for (const sel of primarySelectors) {
      try {
        const count = await page.locator(sel).count();
        if (count > 0) { resolves = true; break; }
      } catch {
        // invalid CSS — continue trying
      }
    }

    if (resolves) {
      repairedSteps.push(step);
      continue;
    }

    // Selector doesn't resolve — attempt semantic repair
    const fixedSelector = await trySemanticRepair(page, step);

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

// ─── Semantic Repair Heuristics ───────────────────────────────────────────────

/**
 * Try progressively looser semantic locators to find the element the AI was
 * targeting. Returns the first working selector, or undefined if none worked.
 */
async function trySemanticRepair(page: Page, step: ExecutionStep): Promise<string | undefined> {
  const desc = step.description;

  // Extract quoted or capitalised label hints from the step description
  const labelHints = extractLabelHints(desc);

  for (const hint of labelHints) {
    // aria-label exact match
    if (await resolves(page, `[aria-label="${hint}"]`)) return `[aria-label="${hint}"]`;
    // aria-label case-insensitive
    if (await resolves(page, `[aria-label="${hint}" i]`)) return `[aria-label="${hint}" i]`;
    // placeholder exact
    if (await resolves(page, `[placeholder="${hint}"]`)) return `[placeholder="${hint}"]`;
    // placeholder case-insensitive partial
    if (await resolves(page, `[placeholder*="${hint}" i]`)) return `[placeholder*="${hint}" i]`;
    // role button
    try {
      const c = await page.getByRole('button', { name: hint }).count();
      if (c > 0) return `[role="button"][aria-label="${hint}"], button[title="${hint}"]`;
    } catch {}
    // role link
    try {
      const c = await page.getByRole('link', { name: hint }).count();
      if (c > 0) return `a[aria-label="${hint}"], a[title="${hint}"]`;
    } catch {}
    // getByLabel (input with associated label element)
    try {
      const c = await page.getByLabel(hint, { exact: false }).count();
      if (c > 0) return `[aria-label*="${hint}" i]`;
    } catch {}
  }

  // Fallback: extract any text content hint for assert steps
  if (step.action === 'assert' && step.assertExpected) {
    const textSel = `*:has-text("${step.assertExpected.slice(0, 40)}")`;
    // Note: :has-text is Playwright-specific, but our executor knows how to handle asserts
    // by checking window.__pathfinder_captures and innerText directly
    return undefined;
  }

  return undefined;
}

function extractLabelHints(description: string): string[] {
  const hints: string[] = [];

  // Quoted strings: 'Room name', "Submit", 'Create button'
  const quoted = description.match(/["']([^"']{2,40})["']/g) ?? [];
  hints.push(...quoted.map((q) => q.slice(1, -1)));

  // "the X field/button/input/link/tab" pattern
  const fieldMatch = description.match(
    /(?:the\s+)?([A-Z][a-zA-Z0-9\s]{1,30}?)\s+(?:field|button|input|link|tab|checkbox|dropdown|icon|label)/gi
  );
  if (fieldMatch) {
    hints.push(
      ...fieldMatch.map((m) =>
        m.replace(/\s*(field|button|input|link|tab|checkbox|dropdown|icon|label)\s*$/i, '').replace(/^the\s+/i, '').trim()
      )
    );
  }

  // Capitalised word sequences (likely UI labels)
  const caps = description.match(/\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*)\b/g) ?? [];
  hints.push(...caps.filter((c) => c.length > 2 && !COMMON_WORDS.has(c.toLowerCase())));

  // Deduplicate and filter noise
  return [...new Set(hints)].filter((h) => h.length >= 2 && h.length <= 50);
}

const COMMON_WORDS = new Set([
  'click', 'type', 'assert', 'verify', 'navigate', 'wait', 'scroll',
  'enter', 'open', 'close', 'submit', 'check', 'uncheck', 'select',
  'the', 'and', 'for', 'with', 'into', 'that', 'this', 'step', 'page',
]);

async function resolves(page: Page, selector: string): Promise<boolean> {
  try {
    const count = await page.locator(selector).count();
    return count > 0;
  } catch {
    return false;
  }
}
