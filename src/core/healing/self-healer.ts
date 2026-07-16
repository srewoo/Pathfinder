import type { ExecutionStep, HealingAttempt } from '../../storage/schemas';
import type { AIClientInterface } from '../ai/ai-client';
import { findSimilarElements } from './dom-similarity';
import { generateAlternativeSelectors } from './selector-generator';
import { buildAttributeSelectors } from './attribute-selector';
import { runStep } from '../executor/action-runner';
import { createLogger } from '../../utils/logger';

const log = createLogger('self-healer');

export interface HealingResult {
  success: boolean;
  healedStep?: ExecutionStep;
  attempt: HealingAttempt;
}

/** Maximum number of selector candidates to try per strategy */
const MAX_CANDIDATES_PER_STRATEGY = 3;

/**
 * Actions that mutate page/app state (or are otherwise non-idempotent). When
 * validating a healed selector for one of these we must NOT perform the action
 * — a click-submit or type executed once per candidate would double-submit
 * forms or corrupt state. Instead we probe that the selector locates a visible
 * element; the executor performs the real action exactly once after healing.
 */
const MUTATING_ACTIONS = new Set([
  'click', 'double_click', 'type', 'clear', 'check', 'uncheck', 'select',
  'press_key', 'drag_drop', 'upload_file', 'navigate', 'dismiss_dialog',
]);

/**
 * Test whether a candidate selector is viable for a step, WITHOUT causing side
 * effects for mutating actions. For safe read-only actions (assert/wait/scroll/
 * hover) it runs the real step; for mutating actions it runs a locate-only
 * `assert visible` probe against the candidate selector.
 */
async function candidateResolves(
  step: ExecutionStep,
  selector: string,
  tabId: number,
  stepRunner: typeof runStep,
): Promise<boolean> {
  if (MUTATING_ACTIONS.has(step.action)) {
    const probe: ExecutionStep = {
      order: step.order,
      action: 'assert',
      assertType: 'visible',
      selector,
      description: `Locate probe for healed selector ${selector}`,
    };
    const r = await stepRunner(probe, tabId);
    return r.status === 'passed';
  }
  const r = await stepRunner({ ...step, selector }, tabId);
  return r.status === 'passed';
}

// ── Cross-Test Healing Registry ─────────────────────────────────────────────
// Caches healed selectors so the same broken selector doesn't need to be
// re-healed across different test cases. Persists for the browser session.

const healingRegistry = new Map<string, string>();

/** Register a successful healing so other tests can benefit. */
export function registerHealedSelector(originalSelector: string, healedSelector: string): void {
  healingRegistry.set(originalSelector, healedSelector);
}

/** Look up a previously healed selector from another test run. */
export function getHealedSelector(originalSelector: string): string | undefined {
  return healingRegistry.get(originalSelector);
}

/** Clear the healing registry (e.g., on major app deploy). */
export function clearHealingRegistry(): void {
  healingRegistry.clear();
}

/**
 * Three-strategy healing pipeline:
 *  1. DOM similarity  — Jaccard match on element attributes vs. step description
 *  2. Attribute selectors — generate valid CSS selectors from the DOM directly
 *  3. AI regeneration  — ask the LLM to produce alternatives from page context
 */
export async function healStep(
  step: ExecutionStep,
  error: string,
  tabId: number,
  aiClient: AIClientInterface,
  /**
   * Runner used to validate candidate selectors. Defaults to the synthetic
   * content-script runner, but the executor passes its ACTIVE runner (CDP
   * trusted events when a CDP session is live) so healing validates selectors
   * under the same event model the test actually uses.
   */
  stepRunner: typeof runStep = runStep
): Promise<HealingResult> {
  const originalSelector = step.selector ?? '';

  // ── Strategy 0: Check cross-test healing registry ──────────────────────
  // If another test already healed this exact selector, try it first (zero cost).
  const cachedHeal = getHealedSelector(originalSelector);
  if (cachedHeal) {
    if (await candidateResolves(step, cachedHeal, tabId, stepRunner)) {
      log.info(`Healed via registry cache: ${cachedHeal}`);
      return makeResult(true, { ...step, selector: cachedHeal }, step.order, originalSelector, 'similarity', cachedHeal);
    }
    // Cached heal no longer works — remove stale entry
    healingRegistry.delete(originalSelector);
  }

  // -------------------------------------------------------------------------
  // Strategy 1: DOM similarity matching
  // -------------------------------------------------------------------------
  log.info(`Strategy 1 (DOM similarity) for: ${originalSelector}`);
  const similarSelectors = await findSimilarElements(originalSelector, step.description, tabId);

  for (const selector of similarSelectors.slice(0, MAX_CANDIDATES_PER_STRATEGY)) {
    if (await candidateResolves(step, selector, tabId, stepRunner)) {
      log.info(`Healed via DOM similarity: ${selector}`);
      return makeResult(true, { ...step, selector }, step.order, originalSelector, 'similarity', selector);
    }
  }

  // -------------------------------------------------------------------------
  // Strategy 2: Attribute-based CSS selectors derived directly from the DOM
  // -------------------------------------------------------------------------
  log.info(`Strategy 2 (attribute selectors) for: ${originalSelector}`);
  const attrSelectors = await buildAttributeSelectors(step.description, tabId);

  for (const selector of attrSelectors.slice(0, MAX_CANDIDATES_PER_STRATEGY)) {
    if (await candidateResolves(step, selector, tabId, stepRunner)) {
      log.info(`Healed via attribute selector: ${selector}`);
      return makeResult(true, { ...step, selector }, step.order, originalSelector, 'alternative', selector);
    }
  }

  // -------------------------------------------------------------------------
  // Strategy 3: AI selector regeneration
  // -------------------------------------------------------------------------
  log.info(`Strategy 3 (AI regeneration) for: ${originalSelector}`);

  const aiSelectors = await generateAlternativeSelectors(
    originalSelector,
    step.description,
    tabId,
    aiClient
  );

  for (const selector of aiSelectors.slice(0, MAX_CANDIDATES_PER_STRATEGY)) {
    if (await candidateResolves(step, selector, tabId, stepRunner)) {
      log.info(`Healed via AI: ${selector}`);
      return makeResult(true, { ...step, selector }, step.order, originalSelector, 'ai', selector);
    }
  }

  log.warn(`All healing strategies exhausted for: ${originalSelector}`);
  return makeResult(false, undefined, step.order, originalSelector, 'ai', undefined, error);
}

function makeResult(
  success: boolean,
  healedStep: ExecutionStep | undefined,
  stepOrder: number,
  originalSelector: string,
  method: HealingAttempt['method'],
  healedSelector?: string,
  error?: string
): HealingResult {
  return {
    success,
    healedStep,
    attempt: {
      stepOrder,
      originalSelector,
      method,
      healedSelector,
      success,
      error,
    },
  };
}
