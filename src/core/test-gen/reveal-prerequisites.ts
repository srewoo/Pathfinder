/**
 * Reveal prerequisites — the deterministic half of the grounding gate.
 *
 * Some fields only exist after something is clicked. Measured on a live login
 * page: "Sign in with your username" is a plain button that swaps
 * username/password into the page, with no URL change and no dialog. Exploration
 * now records that as `PageNode.revealedForms`, and the same is true of fields
 * inside a modal or an in-page tab.
 *
 * The prompt tells the model to click the trigger first. This module is what
 * makes that a guarantee rather than a request: a plan that types into a field
 * which is not in the DOM yet fails validation naming the step it is missing,
 * instead of failing at run time against a missing element — where it is
 * indistinguishable from the application being broken.
 */
import type { ExecutionStep, PageNode } from '../../storage/schemas';

/** A selector that exists only once something else has happened. */
export interface RevealPrerequisite {
  /** The selector that is gated. */
  selector: string;
  /** How to make it exist. */
  kind: 'click-trigger' | 'open-tab';
  /** Selector to click, for `click-trigger`. */
  triggerSelector?: string;
  /** Human label of the trigger or tab. */
  triggerLabel: string;
  /** URL to navigate to, for `open-tab`. */
  tabUrl?: string;
}

/**
 * Every gated selector on a page, and what unlocks it.
 *
 * A selector present in the page's own `formFields` or element inventory is not
 * gated, even if it also appears behind a trigger — if it is reachable without
 * the click, requiring one would reject a perfectly good plan.
 */
export function revealPrerequisites(node: PageNode | undefined): Map<string, RevealPrerequisite> {
  const out = new Map<string, RevealPrerequisite>();
  if (!node) return out;

  const ungated = new Set<string>();
  for (const field of node.formFields ?? []) ungated.add(field.selector);

  const add = (selector: string, prereq: RevealPrerequisite) => {
    if (!selector || ungated.has(selector) || out.has(selector)) return;
    out.set(selector, prereq);
  };

  for (const reveal of node.revealedForms ?? []) {
    for (const field of reveal.formFields ?? []) {
      add(field.selector, {
        selector: field.selector,
        kind: 'click-trigger',
        triggerSelector: reveal.triggerSelector,
        triggerLabel: reveal.triggerLabel,
      });
    }
  }

  // Modals are the same shape of problem: the field is real, and unreachable
  // until its trigger opens the dialog.
  for (const modal of node.modals ?? []) {
    for (const field of modal.formFields ?? []) {
      add(field.selector, {
        selector: field.selector,
        kind: 'click-trigger',
        triggerSelector: modal.triggerSelector,
        triggerLabel: modal.triggerLabel,
      });
    }
  }

  for (const tab of node.tabs ?? []) {
    for (const field of tab.formFields ?? []) {
      add(field.selector, {
        selector: field.selector,
        kind: 'open-tab',
        triggerLabel: tab.label,
        tabUrl: tab.url,
      });
    }
  }

  return out;
}

export interface MissingPrerequisite {
  /** The step that cannot run yet. */
  stepOrder: number;
  selector: string;
  prerequisite: RevealPrerequisite;
  /** What to tell the user, naming the step that is missing. */
  message: string;
}

/** Steps that interact with an element, so a gated selector actually matters. */
const INTERACTING_ACTIONS = new Set([
  'click',
  'double_click',
  'type',
  'clear',
  'check',
  'uncheck',
  'select',
  'hover',
  'upload_file',
  'assert',
]);

function satisfies(step: ExecutionStep, prereq: RevealPrerequisite): boolean {
  if (prereq.kind === 'click-trigger') {
    return step.action === 'click' && !!prereq.triggerSelector && step.selector === prereq.triggerSelector;
  }
  // Opening the tab counts whether the plan navigates to it or clicks into it.
  if (step.action === 'navigate') return !!prereq.tabUrl && step.value === prereq.tabUrl;
  return false;
}

/**
 * Steps whose target is gated and whose unlocking step is missing or too late.
 *
 * Order matters, not mere presence: clicking the trigger *after* typing into the
 * field it reveals is still a plan that types into nothing.
 */
export function missingPrerequisites(
  steps: readonly ExecutionStep[],
  prerequisites: ReadonlyMap<string, RevealPrerequisite>
): MissingPrerequisite[] {
  if (prerequisites.size === 0) return [];
  const ordered = [...steps].sort((a, b) => a.order - b.order);
  const missing: MissingPrerequisite[] = [];

  for (const [index, step] of ordered.entries()) {
    if (!step.selector || !INTERACTING_ACTIONS.has(step.action)) continue;
    const prereq = prerequisites.get(step.selector);
    if (!prereq) continue;
    // A step that clicks the trigger itself is not gated by it.
    if (satisfies(step, prereq)) continue;

    const satisfiedEarlier = ordered.slice(0, index).some((earlier) => satisfies(earlier, prereq));
    if (satisfiedEarlier) continue;

    missing.push({
      stepOrder: step.order,
      selector: step.selector,
      prerequisite: prereq,
      message:
        prereq.kind === 'click-trigger'
          ? `Step ${step.order} targets "${step.selector}", which only exists after ` +
            `"${prereq.triggerLabel}" is clicked. Add a click on ` +
            `"${prereq.triggerSelector}" before it.`
          : `Step ${step.order} targets "${step.selector}", which only exists inside the ` +
            `"${prereq.triggerLabel}" view. Navigate to ${prereq.tabUrl} before it.`,
    });
  }

  return missing;
}

/**
 * The step that should be inserted to satisfy a missing prerequisite.
 *
 * Returned rather than applied: repairing a plan is the caller's decision, and
 * a plan the user has reviewed should not change under them silently.
 */
export function prerequisiteStep(
  missing: MissingPrerequisite,
  order: number
): ExecutionStep | undefined {
  const { prerequisite } = missing;
  if (prerequisite.kind === 'click-trigger') {
    if (!prerequisite.triggerSelector) return undefined;
    return {
      order,
      action: 'click',
      selector: prerequisite.triggerSelector,
      description: `Click "${prerequisite.triggerLabel}" to reveal the form`,
    };
  }
  if (!prerequisite.tabUrl) return undefined;
  return {
    order,
    action: 'navigate',
    value: prerequisite.tabUrl,
    description: `Open the "${prerequisite.triggerLabel}" view`,
  };
}
