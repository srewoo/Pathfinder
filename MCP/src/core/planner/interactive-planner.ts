/**
 * Interactive Test Planner
 *
 * Instead of generating all steps at once from a single DOM snapshot (single-shot),
 * this planner walks the app step-by-step — executing each action and observing the
 * ACTUAL resulting page state before deciding the next action.
 *
 * Result: selectors are verified against the live DOM, intermediate page states are
 * observed (not guessed), and the plan only includes steps that actually worked.
 *
 * The generated step list is then replayed by the normal test-executor with healing,
 * giving us the best of both worlds: accurate plans + resilient replay.
 */

import type { Page } from 'playwright';
import type { AIClientInterface } from '../ai/ai-client.js';
import type { ExecutionStep, ActionType, AssertType } from '../../storage/schemas.js';
import { executeStepOnPage, getAccessibilitySnapshot } from '../../browser/playwright-adapter.js';
import { PROMPTS } from '../ai/prompt-templates.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('interactive-planner');
const DEFAULT_MAX_STEPS = 30;

export interface InteractivePlanResult {
  steps: ExecutionStep[];
  goalAchieved: boolean;
  stepsExecuted: number;
  failureReason?: string;
}

/**
 * Walk the app step-by-step to produce a verified execution plan.
 *
 * @param page       - Live Playwright page, already navigated to the start URL.
 * @param goal       - Human-readable test goal (one-liner title + description).
 * @param aiClient   - AI client for per-step decisions.
 * @param maxSteps   - Safety cap on iterations (default 15).
 */
export async function interactivePlan(
  page: Page,
  goal: string,
  aiClient: AIClientInterface,
  maxSteps = DEFAULT_MAX_STEPS
): Promise<InteractivePlanResult> {
  const completedSteps: ExecutionStep[] = [];
  let goalAchieved = false;
  let failureReason: string | undefined;

  log.info(`Interactive planning for: "${goal.slice(0, 80)}"`);

  for (let iteration = 0; iteration < maxSteps; iteration++) {
    const currentUrl = page.url();
    const ariaSnapshot = await getAccessibilitySnapshot(page).catch(() => '');

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
          { role: 'user', content: prompt.user(goal, currentUrl, ariaSnapshot, stepsSoFar) },
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
      // Include a final assert step if the AI provided one
      if (parsed.action === 'assert' && parsed.selector) {
        completedSteps.push(buildStep(parsed, completedSteps.length + 1));
      }
      log.info(`Interactive planning complete after ${completedSteps.length} steps (goal achieved)`);
      break;
    }

    const step = buildStep(parsed, completedSteps.length + 1);
    log.info(`Step ${step.order}: [${step.action}] ${step.description.slice(0, 60)}`);

    // Execute and verify the step
    const result = await executeStepOnPage(page, step);

    if (result.status === 'passed') {
      completedSteps.push(step);
      await new Promise((r) => setTimeout(r, 300)); // brief pause for SPA state updates
      continue;
    }

    // Step failed — give AI one retry with failure context
    log.warn(`Step ${step.order} failed (${result.error?.slice(0, 80)}), requesting alternative`);

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
              ariaSnapshot,
              stepsSoFar,
              `Previous attempt failed. Selector "${step.selector}" did not work (error: ${result.error?.slice(0, 120)}). ` +
                `Look at the accessibility tree again and try a different selector or approach.`
            ),
          },
        ],
        { temperature: 0.2, jsonMode: true, maxTokens: 512 }
      );
    } catch {
      // retry AI call failed — stop
    }

    if (retryRaw) {
      const retryParsed = parseNextAction(retryRaw);
      if (retryParsed && !retryParsed.isDone) {
        const retryStep = buildStep(retryParsed, completedSteps.length + 1);
        const retryResult = await executeStepOnPage(page, retryStep);
        if (retryResult.status === 'passed') {
          log.info(`Retry succeeded with alternative selector: ${retryStep.selector}`);
          completedSteps.push(retryStep);
          await new Promise((r) => setTimeout(r, 300));
          continue;
        }
      }
    }

    // Both attempts failed — stop interactive planning
    failureReason = `Stuck at step ${step.order}: "${step.description}" — ${result.error?.slice(0, 100)}`;
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
    return {
      action: normalizeAction(json['action']),
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
  verify: 'assert', expect: 'assert', check_text: 'assert',
  key: 'press_key', keyboard: 'press_key',
  dropdown: 'select', choose: 'select',
};

const VALID_ACTIONS = new Set<ActionType>([
  'click', 'double_click', 'type', 'navigate', 'wait', 'assert', 'scroll',
  'hover', 'select', 'check', 'uncheck', 'clear', 'press_key', 'drag_drop',
  'upload_file', 'dismiss_dialog', 'switch_tab',
]);

function normalizeAction(raw: unknown): ActionType {
  if (typeof raw === 'string') {
    const lower = raw.toLowerCase();
    if (VALID_ACTIONS.has(lower as ActionType)) return lower as ActionType;
    if (ACTION_ALIASES[lower]) return ACTION_ALIASES[lower];
  }
  return 'click';
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
