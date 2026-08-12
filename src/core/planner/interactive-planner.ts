/**
 * Interactive Test Planner (Chrome Extension)
 *
 * Instead of generating all steps at once from a single DOM snapshot (single-shot),
 * this planner walks the app step-by-step — executing each action and observing the
 * ACTUAL resulting page state before deciding the next action.
 *
 * Executes via the CDP driver (fix.md §3) — one execution substrate.
 * The generated step list is then replayed by the normal test-executor with healing.
 */

import type { AIClientInterface } from '../ai/ai-client';
import type { ExecutionStep, ActionType, AssertType } from '../../storage/schemas';
import { getPageSnapshot } from '../explorer/page-scanner';
import { executeStep as executeStepViaPort } from '../step-executor';
import { serializeCompressedDOM } from '../../utils/dom-compress';
import { PROMPTS } from '../ai/prompt-templates';
import { createLogger } from '../../utils/logger';
import { captureState, diffState, type StateSnapshot } from '../analysis/state-diff';
import { deriveDocGroundedAssertions } from './doc-grounded-oracle';
import { driverForTab } from '../step-executor';

const log = createLogger('interactive-planner');
const DEFAULT_MAX_STEPS = 20;

/** Max times the same action+selector can repeat before we detect a loop. */
const MAX_ACTION_REPEATS = 2;

export interface InteractivePlanResult {
  steps: ExecutionStep[];
  goalAchieved: boolean;
  stepsExecuted: number;
  failureReason?: string;
}

/**
 * Walk the app step-by-step to produce a verified execution plan.
 *
 * @param tabId     - The locked Chrome tab running the app.
 * @param goal      - Human-readable test goal (title + description).
 * @param aiClient  - AI client for per-step decisions.
 * @param maxSteps  - Safety cap on iterations (default 15).
 */
export async function interactivePlan(
  tabId: number,
  goal: string,
  aiClient: AIClientInterface,
  maxSteps = DEFAULT_MAX_STEPS
): Promise<InteractivePlanResult> {
  const completedSteps: ExecutionStep[] = [];
  let goalAchieved = false;
  let failureReason: string | undefined;
  /** Track action signatures to detect loops (e.g. click:Rooms → click:New design → click:Rooms…) */
  const actionHistory: string[] = [];

  log.info(`Interactive planning for: "${goal.slice(0, 80)}"`);

  for (let iteration = 0; iteration < maxSteps; iteration++) {
    const snapshot = await getPageSnapshot(tabId).catch(() => null);
    const currentUrl = snapshot?.url ?? '';
    const domContext = snapshot
      ? serializeCompressedDOM({
          url: snapshot.url,
          title: snapshot.title,
          interactiveElements: snapshot.domCompressed,
          visibleText: '',
          truncated: false,
        })
      : 'No DOM snapshot available.';

    const stepsSoFar = completedSteps.length
      ? completedSteps.map((s, i) =>
          `${i + 1}. [${s.action}] ${s.description}${s.selector ? ` (sel: ${s.selector})` : ''}${s.value ? ` → "${s.value}"` : ''}`
        ).join('\n')
      : 'None yet — this is the first step.';

    const prompt = PROMPTS.interactivePlanning;
    let raw: string;
    try {
      raw = await aiClient.chat(
        [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user(goal, currentUrl, domContext, stepsSoFar) },
        ],
        { temperature: 0.1, jsonMode: true, maxTokens: 512 }
      );
    } catch (err) {
      log.warn(`Interactive planner AI call failed at iteration ${iteration + 1}`, err);
      failureReason = `AI call failed: ${err instanceof Error ? err.message : String(err)}`;
      break;
    }

    const parsed = parseNextAction(raw);
    if (!parsed) {
      log.warn(`Failed to parse AI response at iteration ${iteration + 1}: ${raw.slice(0, 200)}`);
      failureReason = 'AI returned unparseable JSON';
      break;
    }

    // AI signals the goal is complete
    if (parsed.isDone) {
      goalAchieved = true;
      if (parsed.action === 'assert' && parsed.selector) {
        completedSteps.push(buildStep(parsed, completedSteps.length + 1));
      }
      log.info(`Interactive planning complete after ${completedSteps.length} steps (goal achieved)`);
      break;
    }

    const step = buildStep(parsed, completedSteps.length + 1);

    // ── Loop detection: catch repeating action cycles ──────────────────
    const actionSig = `${step.action}:${step.selector ?? ''}:${step.value ?? ''}`;
    actionHistory.push(actionSig);

    // Check for 2-step cycles (A→B→A→B) or single-step repeats (A→A→A)
    const repeatCount = actionHistory.filter((s) => s === actionSig).length;
    if (repeatCount > MAX_ACTION_REPEATS) {
      failureReason = `Loop detected: "${step.description}" repeated ${repeatCount} times. The planner is stuck.`;
      log.warn(`Interactive planning stopping: ${failureReason}`);
      break;
    }

    // Check for 2-step cycle pattern (last 4 entries form A-B-A-B)
    if (actionHistory.length >= 4) {
      const last4 = actionHistory.slice(-4);
      if (last4[0] === last4[2] && last4[1] === last4[3] && last4[0] !== last4[1]) {
        failureReason = `2-step loop detected: alternating between "${completedSteps[completedSteps.length - 1]?.description}" and "${step.description}"`;
        log.warn(`Interactive planning stopping: ${failureReason}`);
        break;
      }
    }

    log.info(`Step ${step.order}: [${step.action}] ${step.description.slice(0, 60)}`);

    // Interactive planning is the ONE place a real state diff is available at
    // generation time: it executes each step and observes the result. That is what
    // makes doc-grounded assertions possible — the docs say what should happen, the
    // diff says what did, and the assertion is written against the documented
    // expectation.
    const before = await tryCapture(tabId);
    const succeeded = await executeStep(tabId, step);

    if (succeeded) {
      completedSteps.push(step);

      if (before) {
        const derived = await deriveAssertionsFor(
          tabId,
          step,
          before,
          currentUrl,
          completedSteps.length - 1,
          aiClient
        );
        // Emitted as ordinary assert steps so the rest of the pipeline needs no
        // special case, and each carries the documentation that justifies it.
        for (const assertStep of derived) {
          completedSteps.push({ ...assertStep, order: completedSteps.length + 1 });
        }
      }

      await delay(300); // brief pause for SPA state updates
      continue;
    }

    // Step failed — give AI one retry with failure context
    log.warn(`Step ${step.order} failed, requesting alternative`);

    let retryRaw: string | null = null;
    try {
      retryRaw = await aiClient.chat(
        [
          { role: 'system', content: prompt.system },
          {
            role: 'user',
            content: prompt.user(
              goal,
              currentUrl,
              domContext,
              stepsSoFar,
              `Previous attempt failed. Selector "${step.selector}" did not work. Look at the elements again and try a different selector or approach.`
            ),
          },
        ],
        { temperature: 0.2, jsonMode: true, maxTokens: 512 }
      );
    } catch { /* retry AI call failed — stop */ }

    if (retryRaw) {
      const retryParsed = parseNextAction(retryRaw);
      if (retryParsed && !retryParsed.isDone) {
        const retryStep = buildStep(retryParsed, completedSteps.length + 1);
        if (await executeStep(tabId, retryStep)) {
          log.info(`Retry succeeded with alternative selector: ${retryStep.selector}`);
          completedSteps.push(retryStep);
          await delay(300);
          continue;
        }
      }
    }

    failureReason = `Stuck at step ${step.order}: "${step.description}"`;
    log.warn(`Interactive planning stopping: ${failureReason}`);
    break;
  }

  return {
    steps: completedSteps,
    goalAchieved,
    stepsExecuted: completedSteps.length,
    failureReason,
  };
}

async function executeStep(tabId: number, step: ExecutionStep): Promise<boolean> {
  try {
    // The driver reports the real outcome via { success, error }. We must inspect
    // `success`, otherwise a click on a missing element is recorded as a verified
    // step and the whole "observe actual state" premise collapses.
    const response = await executeStepViaPort(
      {
        order: step.order,
        action: step.action,
        selector: step.selector,
        value: step.value,
        key: step.key,
        assertType: step.assertType,
        assertExpected: step.assertExpected,
        description: step.description,
        timeout: step.timeout ?? 5000,
      },
      tabId
    );
    const success = response?.success ?? false;
    if (!success) {
      log.warn(`Step ${step.order} reported failure: ${response?.error ?? 'unknown error'}`);
    }
    return success;
  } catch (err) {
    log.warn(`Step ${step.order} dispatch failed`, err);
    return false;
  }
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

interface ParsedAction {
  action: ActionType;
  selector?: string;
  value?: string;
  description: string;
  assertType?: AssertType;
  assertExpected?: string;
  key?: string;
  isDone: boolean;
}

function parseNextAction(raw: string): ParsedAction | null {
  try {
    const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
    const json = JSON.parse(cleaned) as Record<string, unknown>;
    const isDone = json['isDone'] === true;
    const action = normalizeAction(json['action']);
    // Reject an unrecognized action instead of coercing it to a click — unless
    // this is a completion signal, where the action field is irrelevant.
    if (action === null && !isDone) return null;
    return {
      action: action ?? 'assert',
      selector: typeof json['selector'] === 'string' ? json['selector'] : undefined,
      value: typeof json['value'] === 'string' ? json['value'] : undefined,
      description: typeof json['description'] === 'string' ? json['description'] : 'Action',
      assertType: typeof json['assertType'] === 'string' ? json['assertType'] as AssertType : undefined,
      assertExpected: typeof json['assertExpected'] === 'string' ? json['assertExpected'] : undefined,
      key: typeof json['key'] === 'string' ? json['key'] : undefined,
      isDone: json['isDone'] === true,
    };
  } catch {
    return null;
  }
}

const ACTION_ALIASES: Record<string, ActionType> = {
  fill: 'type', input: 'type', enter: 'type', write: 'type',
  tap: 'click', press: 'click', goto: 'navigate', visit: 'navigate',
  verify: 'assert', expect: 'assert',
  key: 'press_key', keyboard: 'press_key',
  dropdown: 'select', choose: 'select',
};

const VALID_ACTIONS = new Set<ActionType>([
  'click', 'double_click', 'type', 'navigate', 'wait', 'assert', 'scroll',
  'hover', 'select', 'check', 'uncheck', 'clear', 'press_key', 'drag_drop',
  'upload_file', 'dismiss_dialog',
]);

/** Resolve a raw action to a known ActionType, or `null` if unrecognized. */
function normalizeAction(raw: unknown): ActionType | null {
  if (typeof raw === 'string') {
    const lower = raw.toLowerCase();
    if (VALID_ACTIONS.has(lower as ActionType)) return lower as ActionType;
    if (ACTION_ALIASES[lower]) return ACTION_ALIASES[lower];
  }
  return null;
}

function buildStep(parsed: ParsedAction, order: number): ExecutionStep {
  const step: ExecutionStep = {
    order,
    action: parsed.action,
    description: parsed.description,
  };
  if (parsed.selector) step.selector = parsed.selector;
  if (parsed.value) step.value = parsed.value;
  if (parsed.assertType) step.assertType = parsed.assertType;
  if (parsed.assertExpected) step.assertExpected = parsed.assertExpected;
  if (parsed.key) step.key = parsed.key;
  return step;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


// ── Doc-grounded assertions (deeper oracles) ─────────────────────────────────

/** Capture state, or null when it cannot be observed. Never throws. */
async function tryCapture(tabId: number): Promise<StateSnapshot | null> {
  try {
    return await captureState(driverForTab(tabId));
  } catch {
    return null;
  }
}

/**
 * Ask the documentation what this step should have done, and emit assertions.
 *
 * The model converts documented prose into `Assertion` objects; it never returns a
 * verdict, and the assertions are schema-validated before they become steps (§6,
 * §8.0). When the docs say nothing about this action, nothing is emitted — that
 * silence is the guard that keeps this from inventing expectations.
 *
 * Only runs for steps that could change something: asking the docs what a `type`
 * step should have done wastes a call and invites a fabricated answer.
 */
async function deriveAssertionsFor(
  tabId: number,
  step: ExecutionStep,
  before: StateSnapshot,
  pageUrl: string,
  afterStep: number,
  aiClient: AIClientInterface
): Promise<ExecutionStep[]> {
  if (step.action !== 'click' && step.action !== 'press_key') return [];

  try {
    const driver = driverForTab(tabId);
    const after = await captureState(driver);
    const diff = diffState(before, after, driver.networkLog());

    const result = await deriveDocGroundedAssertions(
      {
        actionDescription: step.description,
        pageUrl,
        diff,
        afterStep,
      },
      aiClient
    );

    if (result.assertions.length === 0) return [];

    log.info(
      `Doc-grounded: +${result.assertions.length} assertion(s) for "${step.description}" ` +
        `from ${result.expectations.length} doc source(s)`
    );

    return result.assertions.map((a) => ({
      order: 0,
      action: 'assert' as const,
      assertType: a.kind as ExecutionStep['assertType'],
      selector: a.locator?.structural?.css ?? a.locator?.testid,
      assertExpected: a.expected,
      attribute: a.attribute,
      // The citation travels with the assertion: a doc-grounded check is only
      // trustworthy if a reader can see which document required it.
      description: `${a.description} [documented]`,
    }));
  } catch (err) {
    // A missing driver, a failed snapshot or an AI error must not stop planning.
    log.debug('Doc-grounded assertion derivation skipped', err);
    return [];
  }
}
