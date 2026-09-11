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
import { assessNavigationGrounding, isAbsoluteAppUrl, resolveNavigationTarget } from '../executor/navigation-target';
import { loadGraph } from '../explorer/interaction-graph';
import { sendToContentScript } from '../../messaging/messenger';
import { createLogger } from '../../utils/logger';
import {
  revealPrerequisites,
  missingPrerequisites,
  prerequisiteStep,
  type MissingPrerequisite,
} from '../test-gen/reveal-prerequisites';

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

  // Known routes, for judging whether a navigate target was observed or invented.
  const graph = await loadGraph().catch(() => undefined);
  const knownUrls = new Set<string>();
  for (const node of graph?.nodes ?? []) {
    knownUrls.add(node.url);
    for (const tab of node.tabs ?? []) knownUrls.add(tab.url);
  }

  const issues: ValidationIssue[] = [];
  const repairedSteps: ExecutionStep[] = [];

  // ── Reveal prerequisites ──────────────────────────────────────────────────
  //
  // A field that only exists after a click is not a broken selector — it is a
  // missing step. The live-DOM check below cannot tell those apart: the element
  // genuinely is not there, so the selector "fails to resolve" and auto-repair
  // goes looking for a semantic alternative that does not exist either. Naming
  // the missing trigger is the only useful answer, and it has to be computed
  // from the exploration graph rather than the page.
  const currentNode = graph?.nodes.find((n) => n.url === snapshot?.url);
  const prerequisites = revealPrerequisites(currentNode);
  const gated = missingPrerequisites(steps, prerequisites);
  for (const miss of gated) {
    issues.push({
      stepOrder: miss.stepOrder,
      description: miss.message,
      selector: miss.selector,
    });
  }
  if (gated.length > 0) {
    log.warn(
      `Plan is missing ${gated.length} reveal prerequisite(s): ` +
        gated.map((m) => `step ${m.stepOrder} needs "${m.prerequisite.triggerLabel}"`).join('; ')
    );
  }
  // Selectors already explained by a missing prerequisite are not also reported
  // as unresolvable — two issues for one cause reads as two problems.
  const gatedSelectors = new Set(gated.map((m) => m.selector));

  for (const step of steps) {
    // A navigate step carries a URL, not a selector, so it was skipped entirely —
    // and a generated value like "/university/command-center" sailed through to
    // execution, where it resolved against the extension and put the tab on
    // chrome-extension://<id>/university/command-center. Repairing it here is
    // cheaper than failing the run: the page under validation IS the app, so its
    // URL is the right base.
    if (step.action === 'navigate') {
      if (step.value && !isAbsoluteAppUrl(step.value)) {
        const target = resolveNavigationTarget(step.value, { currentUrl: snapshot?.url });
        if (target.ok) {
          issues.push({
            stepOrder: step.order,
            description: `navigate target "${step.value}" is not an absolute URL`,
            selector: step.value,
            fixedSelector: target.url,
          });
          repairedSteps.push({ ...step, value: target.url });
        } else {
          // Left as-is deliberately: the executor refuses it with a specific
          // reason, which is more useful than a silently rewritten guess here.
          issues.push({
            stepOrder: step.order,
            description: `navigate target cannot be resolved: ${target.error}`,
            selector: step.value,
          });
          repairedSteps.push(step);
        }
        continue;
      }
      // Absolute already — but is it a URL this app actually serves? An
      // unobserved target is reported, never rewritten: substituting a guess of
      // our own would be the same error with a different author.
      if (step.value) {
        const grounding = assessNavigationGrounding(step.value, {
          knownUrls,
          mappedPageCount: graph?.nodes.length ?? 0,
        });
        if (!grounding.grounded) {
          issues.push({
            stepOrder: step.order,
            description: `navigate target is not grounded in exploration data: ${grounding.reason}`,
            selector: step.value,
          });
        }
      }
      repairedSteps.push(step);
      continue;
    }

    if (!step.selector || SKIP_ACTIONS.has(step.action)) {
      repairedSteps.push(step);
      continue;
    }

    // Already explained: the element is absent because a step is missing, not
    // because the selector is wrong. Auto-repair would hunt for a semantic
    // alternative that cannot exist and replace a correct selector with a guess.
    if (gatedSelectors.has(step.selector)) {
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

  // ── Insert the missing reveal steps ──────────────────────────────────────
  //
  // Reported AND repaired, which is the same choice this module already makes
  // for an unresolvable navigate target: "repairing it here is cheaper than
  // failing the run". The difference from a selector guess is that nothing is
  // being guessed — the trigger and its selector were observed during
  // exploration, so the inserted step is as grounded as the rest of the plan.
  //
  // A prerequisite that cannot be turned into a step stays reported and
  // unrepaired, so `valid` goes false and the caller is told what is missing
  // rather than handed a plan that will fail on a missing element.
  const withPrerequisites = insertPrerequisiteSteps(repairedSteps, gated, issues);

  const unrepairedCount = issues.filter((i) => !i.fixedSelector).length;
  if (issues.length > 0) {
    log.info(`Plan validation: ${issues.length} issues (${issues.length - unrepairedCount} repaired, ${unrepairedCount} unresolved)`);
  }

  return {
    valid: unrepairedCount === 0,
    issues,
    repairedSteps: withPrerequisites,
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

/**
 * Put each missing trigger step immediately before the step that needs it.
 *
 * Orders are renumbered sequentially afterwards so the plan stays contiguous;
 * this runs at plan time, before any resume offset exists, so renumbering
 * cannot disturb a resumed run.
 */
function insertPrerequisiteSteps(
  steps: readonly ExecutionStep[],
  gated: readonly MissingPrerequisite[],
  issues: ValidationIssue[]
): ExecutionStep[] {
  if (gated.length === 0) return [...steps];

  // One insertion per distinct trigger: a single click reveals the whole form,
  // so inserting it per gated field would click it two or three times.
  const inserted = new Set<string>();
  const out: ExecutionStep[] = [];

  for (const step of steps) {
    const miss = gated.find((m) => m.stepOrder === step.order);
    if (miss) {
      const key = miss.prerequisite.triggerSelector ?? miss.prerequisite.tabUrl ?? '';
      if (!inserted.has(key)) {
        const prereqStep = prerequisiteStep(miss, step.order);
        if (prereqStep) {
          inserted.add(key);
          out.push(prereqStep);
          issues.push({
            stepOrder: step.order,
            description: `inserted "${prereqStep.description}" — ${miss.selector} does not exist until then`,
            selector: miss.selector,
            fixedSelector: prereqStep.selector ?? prereqStep.value ?? '',
          });
        }
      }
    }
    out.push(step);
  }

  return out.map((step, index) => ({ ...step, order: index + 1 }));
}
