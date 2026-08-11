/**
 * Actionability preconditions (fix.md §8).
 *
 * Every action asserts this precondition set before dispatch, retrying until
 * timeout. Solved once here, no prompt and no test author ever writes a wait
 * again — and ad-hoc `waitForNetworkIdle` / `waitForDomSettle` call sites stop
 * being load-bearing.
 *
 * This module is PURE: it decides whether a sampled state is actionable and
 * what to report when it is not. Sampling itself belongs to the driver, so the
 * decision logic is unit-testable with no browser.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One sample of an element's state, as observed by a driver. */
export interface ElementSample {
  attached: boolean;
  visible: boolean;
  enabled: boolean;
  /** Center point of the element, viewport coordinates. */
  rect: Rect | null;
  /**
   * True when a hit-test at the element's click point resolves to the element
   * itself or one of its descendants. False means something is on top of it.
   */
  receivesEvents: boolean;
  /** Describes the obscuring element when `receivesEvents` is false. */
  obscuredBy?: string;
}

export type ActionabilityCheck =
  | 'attached'
  | 'visible'
  | 'stable'
  | 'enabled'
  | 'receivesEvents';

export const ALL_CHECKS: readonly ActionabilityCheck[] = [
  'attached',
  'visible',
  'stable',
  'enabled',
  'receivesEvents',
] as const;

export interface ActionabilityVerdict {
  actionable: boolean;
  /** Checks that failed, in canonical order. Empty when actionable. */
  failed: ActionabilityCheck[];
  /** Human-readable reason for the first failure. */
  reason?: string;
}

/**
 * Which checks an action requires.
 *
 * Not every action needs the full set — asserting that an element is *not*
 * visible obviously must not require visibility, and a hidden `input[type=file]`
 * is legitimately unclickable yet perfectly settable. Encoding this per-action
 * avoids the usual workaround of disabling waits entirely.
 */
export const CHECKS_FOR_ACTION: Record<string, readonly ActionabilityCheck[]> = {
  click: ALL_CHECKS,
  double_click: ALL_CHECKS,
  hover: ALL_CHECKS,
  drag_drop: ALL_CHECKS,
  check: ALL_CHECKS,
  uncheck: ALL_CHECKS,
  select: ALL_CHECKS,
  // Typing needs a focusable, enabled field but tolerates partial occlusion —
  // floating labels and inline validation icons commonly overlap the input.
  type: ['attached', 'visible', 'stable', 'enabled'],
  clear: ['attached', 'visible', 'stable', 'enabled'],
  press_key: ['attached'],
  // File inputs are routinely `display:none` behind a styled button.
  upload_file: ['attached'],
  capture_value: ['attached'],
  scroll: ['attached'],
} as const;

const DEFAULT_CHECKS: readonly ActionabilityCheck[] = ['attached'];

export function checksForAction(action: string): readonly ActionabilityCheck[] {
  return CHECKS_FOR_ACTION[action] ?? DEFAULT_CHECKS;
}

// ── Decision ────────────────────────────────────────────────────────────────

/** Movement below this many px between samples counts as stable. */
export const STABILITY_EPSILON_PX = 1;

/**
 * Is `current` actionable, given the immediately preceding sample?
 *
 * `previous` is null on the first poll, which can never satisfy `stable` — one
 * sample cannot establish that a box has stopped moving. That costs one poll
 * interval and is the entire reason mid-animation clicks stop happening.
 */
export function evaluateActionability(
  current: ElementSample,
  previous: ElementSample | null,
  required: readonly ActionabilityCheck[] = ALL_CHECKS
): ActionabilityVerdict {
  const failed: ActionabilityCheck[] = [];
  const reasons: Partial<Record<ActionabilityCheck, string>> = {};

  for (const check of ALL_CHECKS) {
    if (!required.includes(check)) continue;

    switch (check) {
      case 'attached':
        if (!current.attached) {
          failed.push(check);
          reasons.attached = 'element is not attached to the document';
        }
        break;

      case 'visible':
        if (!current.visible) {
          failed.push(check);
          reasons.visible = 'element is not visible (zero box, display:none, or visibility:hidden)';
        } else if (!current.rect || current.rect.width <= 0 || current.rect.height <= 0) {
          failed.push(check);
          reasons.visible = 'element has an empty bounding box';
        }
        break;

      case 'stable':
        if (!isStable(current, previous)) {
          failed.push(check);
          reasons.stable = previous
            ? 'element is still moving between samples'
            : 'stability not yet established (first sample)';
        }
        break;

      case 'enabled':
        if (!current.enabled) {
          failed.push(check);
          reasons.enabled = 'element is disabled or aria-disabled';
        }
        break;

      case 'receivesEvents':
        if (!current.receivesEvents) {
          failed.push(check);
          reasons.receivesEvents = current.obscuredBy
            ? `element is obscured by ${current.obscuredBy}`
            : 'element does not receive pointer events at its click point';
        }
        break;
    }
  }

  const first = failed[0];
  return {
    actionable: failed.length === 0,
    failed,
    reason: first ? reasons[first] : undefined,
  };
}

/**
 * Geometric stability: same position and size as the previous sample, within
 * epsilon. Size is compared too — an element mid-expand has a static origin but
 * a moving click point.
 */
export function isStable(current: ElementSample, previous: ElementSample | null): boolean {
  if (!previous) return false;
  const a = current.rect;
  const b = previous.rect;
  if (!a || !b) return false;
  return (
    Math.abs(a.x - b.x) < STABILITY_EPSILON_PX &&
    Math.abs(a.y - b.y) < STABILITY_EPSILON_PX &&
    Math.abs(a.width - b.width) < STABILITY_EPSILON_PX &&
    Math.abs(a.height - b.height) < STABILITY_EPSILON_PX
  );
}

/** Center point of a rect — where a click is dispatched. */
export function centerOf(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

// ── Error reporting ─────────────────────────────────────────────────────────

export class NotActionableError extends Error {
  readonly isOperational = true;

  constructor(
    readonly target: string,
    readonly verdict: ActionabilityVerdict,
    readonly waitedMs: number
  ) {
    super(
      `Element "${target}" did not become actionable within ${waitedMs}ms — ` +
        `failed: [${verdict.failed.join(', ')}]` +
        (verdict.reason ? ` (${verdict.reason})` : '')
    );
    this.name = 'NotActionableError';
  }
}
