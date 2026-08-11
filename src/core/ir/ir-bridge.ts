/**
 * Legacy `ExecutionStep[]` → validated `TestIR` (fix.md §6).
 *
 * The migration seam. Generation still emits `ExecutionStep`, so rather than
 * rewriting every generator at once, everything is funnelled through here: the
 * IR becomes the canonical form, `parseTestIR` becomes the single gate, and the
 * generators can move over one at a time behind a stable contract.
 *
 * Conversion is deliberately LOSSY IN ONE DIRECTION and says so. Three legacy
 * constructs have no IR equivalent, and each is reported rather than silently
 * dropped — a step that vanishes during conversion is a test that quietly stops
 * checking something:
 *
 *   - `wait` — §8 moved waiting into the driver. Dropped, and counted.
 *   - `if_visible` / `loop` — control flow the IR has no vocabulary for.
 *   - `use_captured` — subsumed by `{{placeholder}}` interpolation.
 */
import type { ExecutionStep, TestCase } from '../../storage/schemas';
import type { Assertion, AssertKind, Step, StepAction, TestIR } from './test-ir';
import { IR_VERSION, safeParseTestIR } from './test-ir';
import { fromCss, type Locator } from '../locator';

export interface ConversionResult {
  ir: TestIR | null;
  /** Why conversion failed, when `ir` is null. */
  errors: string[];
  /** Steps that could not be represented, with the reason. Never silent. */
  dropped: Array<{ order: number; action: string; reason: string }>;
}

/** Legacy actions with no IR representation, and why. */
const UNREPRESENTABLE: Record<string, string> = {
  wait: 'waiting is handled by driver actionability preconditions (§8)',
  if_visible: 'conditional control flow is not in the IR vocabulary',
  loop: 'loop control flow is not in the IR vocabulary',
  use_captured: 'superseded by {{placeholder}} interpolation',
  dismiss_dialog: 'dialogs are auto-dismissed for the whole session at driver open',
};

const ACTION_MAP: Record<string, StepAction> = {
  click: 'click',
  double_click: 'double_click',
  type: 'type',
  navigate: 'navigate',
  scroll: 'scroll',
  hover: 'hover',
  select: 'select',
  check: 'check',
  uncheck: 'uncheck',
  clear: 'clear',
  press_key: 'press_key',
  drag_drop: 'drag_drop',
  upload_file: 'upload_file',
  capture_value: 'capture',
};

const ASSERT_MAP: Record<string, AssertKind> = {
  visible: 'visible',
  not_visible: 'not_visible',
  text: 'text',
  not_text: 'not_text',
  url: 'url',
  count: 'count',
  exact_count: 'exact_count',
  enabled: 'enabled',
  disabled: 'disabled',
  value: 'value',
  attribute: 'attribute',
  exists: 'exists',
  not_exists: 'not_exists',
  api_called: 'api_called',
  api_not_called: 'api_not_called',
  api_status: 'api_status',
};

/**
 * Convert a legacy test case.
 *
 * Assertions interleaved with actions become POSITIONAL assertions pinned to the
 * preceding step, preserving the original mid-flow semantics. Flattening them to
 * the end would silently change what the test checks.
 */
export function testCaseToIR(
  testCase: TestCase,
  steps: readonly ExecutionStep[],
  opts: { now?: number; source?: TestIR['provenance']['source'] } = {}
): ConversionResult {
  const dropped: ConversionResult['dropped'] = [];
  const irSteps: Step[] = [];
  const assertions: Assertion[] = [];

  let stepOrder = 0;
  let assertOrder = 0;
  /** Order of the last emitted step — what a following assertion attaches to. */
  let lastStepOrder: number | undefined;

  for (const legacy of [...steps].sort((a, b) => a.order - b.order)) {
    if (legacy.action === 'assert') {
      const kind = ASSERT_MAP[legacy.assertType ?? 'visible'];
      if (!kind) {
        dropped.push({
          order: legacy.order,
          action: `assert:${legacy.assertType}`,
          reason: `unknown assertType "${legacy.assertType}"`,
        });
        continue;
      }
      assertions.push({
        order: assertOrder++,
        kind,
        locator: legacy.selector ? locatorOf(legacy.selector, legacy.description) : undefined,
        expected: legacy.assertExpected,
        attribute: legacy.attribute,
        description: legacy.description || `assert ${kind}`,
        // Legacy plans carry no provenance, and an unlabelled expectation is the
        // false-positive risk — so it is labelled `inferred`, not assumed sound.
        confidence: 'inferred',
        afterStep: lastStepOrder,
      });
      continue;
    }

    const reason = UNREPRESENTABLE[legacy.action];
    if (reason) {
      dropped.push({ order: legacy.order, action: legacy.action, reason });
      continue;
    }

    const action = ACTION_MAP[legacy.action];
    if (!action) {
      dropped.push({
        order: legacy.order,
        action: legacy.action,
        reason: 'no IR equivalent for this action',
      });
      continue;
    }

    const step: Step = {
      order: stepOrder,
      action,
      description: legacy.description || `${action} step`,
      locator: legacy.selector ? locatorOf(legacy.selector, legacy.description) : undefined,
      targetLocator: legacy.targetSelector ? locatorOf(legacy.targetSelector) : undefined,
      value: normalizeValue(legacy),
      key: legacy.key,
      captureAs: legacy.captureName,
      captureFrom: legacy.captureSource,
      attribute: legacy.attribute,
      timeoutMs: legacy.timeout,
    };

    irSteps.push(step);
    lastStepOrder = stepOrder;
    stepOrder++;
  }

  const parsed = safeParseTestIR({
    irVersion: IR_VERSION,
    id: testCase.id,
    name: testCase.title,
    startUrl: testCase.startUrl,
    provenance: {
      source: opts.source ?? 'exploration',
      promptVersion: 'legacy',
      model: 'legacy',
      generatedAt: opts.now ?? 0,
      deterministic: false,
    },
    steps: irSteps,
    assertions,
    tags: [],
  });

  if (!parsed.ok) return { ir: null, errors: parsed.issues, dropped };
  return { ir: parsed.ir, errors: [], dropped };
}

/**
 * Convert IR back to legacy steps.
 *
 * Needed while the legacy executor still exists. Positional assertions are
 * re-interleaved at their pinned step so the round trip preserves ordering.
 */
export function irToExecutionSteps(ir: TestIR): ExecutionStep[] {
  const out: ExecutionStep[] = [];
  let order = 0;

  const byStep = new Map<number, Assertion[]>();
  const atEnd: Assertion[] = [];
  for (const a of [...ir.assertions].sort((x, y) => x.order - y.order)) {
    if (a.afterStep === undefined) atEnd.push(a);
    else byStep.set(a.afterStep, [...(byStep.get(a.afterStep) ?? []), a]);
  }

  const emitAssertion = (a: Assertion) => {
    out.push({
      order: order++,
      action: 'assert',
      assertType: a.kind,
      selector: a.locator ? cssOf(a.locator) : undefined,
      assertExpected: a.expected,
      attribute: a.attribute,
      description: a.description,
    });
  };

  for (const step of [...ir.steps].sort((a, b) => a.order - b.order)) {
    out.push({
      order: order++,
      action: legacyActionOf(step.action),
      selector: step.locator ? cssOf(step.locator) : undefined,
      targetSelector: step.targetLocator ? cssOf(step.targetLocator) : undefined,
      value: step.value,
      key: step.key,
      captureName: step.captureAs,
      captureSource: step.captureFrom,
      attribute: step.attribute,
      timeout: step.timeoutMs,
      description: step.description,
    });
    for (const a of byStep.get(step.order) ?? []) emitAssertion(a);
  }

  for (const a of atEnd) emitAssertion(a);
  return out;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a locator from a legacy CSS selector.
 *
 * A `[data-testid=...]` selector is promoted to the testid tier — it IS a
 * durable identifier, and leaving it structural would understate testability and
 * forgo the more robust resolution path.
 */
export function locatorOf(selector: string, label?: string): Locator {
  const testid = /\[data-testid=["']?([^"'\]]+)["']?\]/.exec(selector);
  if (testid) {
    return {
      testid: testid[1],
      structural: { css: selector },
      preferredTier: 'testid',
      label: label ?? selector,
    };
  }
  return fromCss(selector, label);
}

/** Best CSS representation of a locator, for the legacy path. */
function cssOf(loc: Locator): string {
  if (loc.structural?.css) return loc.structural.css;
  if (loc.testid) return `[data-testid="${loc.testid}"]`;
  return '';
}

function legacyActionOf(action: StepAction): ExecutionStep['action'] {
  if (action === 'capture') return 'capture_value';
  return action as ExecutionStep['action'];
}

/**
 * `use_captured` stored the variable name in `value`; IR expresses the same thing
 * as `{{name}}` interpolation. Normalising here is what lets that action be
 * dropped without losing the substitution.
 */
function normalizeValue(step: ExecutionStep): string | undefined {
  if (step.action === 'use_captured' && step.value) return `{{${step.value}}}`;
  return step.value;
}

/** Human-readable summary of what conversion could not represent. */
export function describeDropped(dropped: ConversionResult['dropped']): string {
  if (dropped.length === 0) return '';
  const byReason = new Map<string, number>();
  for (const d of dropped) byReason.set(d.reason, (byReason.get(d.reason) ?? 0) + 1);
  return [...byReason.entries()].map(([reason, n]) => `${n}× ${reason}`).join('; ');
}
