import type { Page } from 'playwright';
import type { TestCase, TestResult, StepResult, ExecutionStep, ExecutionPlan } from '../../storage/schemas.js';
import type { AIClientInterface } from '../ai/ai-client.js';
import { planTest } from '../planner/test-planner.js';
import { interactivePlan } from '../planner/interactive-planner.js';
import { validateAndRepairPlan } from '../planner/plan-validator.js';
import { executeStepOnPage, screenshotPage, getPageSnapshotFromPage } from '../../browser/playwright-adapter.js';
import { healStep } from '../healing/self-healer.js';
import { generatePostStepAssertion, assertionToStep } from './assertion-generator.js';
import { testCaseRepo } from '../../storage/repositories/test-case-repo.js';
import { testResultRepo } from '../../storage/repositories/test-result-repo.js';
import { planCacheRepo } from '../../storage/repositories/plan-cache-repo.js';
import { generateId, generateRunId } from '../../utils/hash.js';
import { recordStepTiming, suggestTimeoutMultiplier } from '../../memory/timing-memory.js';
import { createLogger } from '../../utils/logger.js';
import { compareWithBaseline } from '../visual/visual-diff.js';

const log = createLogger('executor');
const MAX_RETRIES = 2;

export type PlanningMode =
  /** AI generates the full plan from a single DOM snapshot (fast, ~1 AI call). */
  | 'single-shot'
  /** AI walks the app step-by-step, verifying each action live (slower, best quality). */
  | 'interactive'
  /** Use interactive on attempt 1; fall back to single-shot on retries. */
  | 'auto';

export interface ExecutionOptions {
  onStepResult?: (testCaseId: string, stepOrder: number, result: StepResult) => void;
  onTestStart?: (testCase: TestCase) => void;
  onTestComplete?: (result: TestResult) => void;
  runId?: string;
  headless?: boolean;
  storageStatePath?: string;
  /**
   * Planning strategy for step generation.
   * - 'single-shot' (default): one AI call generates all steps at once.
   * - 'interactive': AI walks the app live, verifying each step before recording it.
   * - 'auto': interactive on attempt 1, single-shot on retries.
   */
  planningMode?: PlanningMode;
  /**
   * When true and using single-shot planning, validate generated selectors against
   * the live page and attempt auto-repair before execution begins.
   */
  validatePlan?: boolean;
  /**
   * When true, after each key action step (click, navigate, select), the AI captures
   * the live DOM and generates an assertion verifying the observed state change.
   */
  useAIAssertions?: boolean;
  /** AbortSignal to stop the test run early. */
  signal?: AbortSignal;
  /**
   * When set, replace the explored app's origin with this target origin at
   * runtime (e.g. switch integration → staging). Stored test data is never
   * modified — the rewrite is applied at execution time only.
   */
  targetOrigin?: string;
}

export async function executeTest(page: Page, testCase: TestCase, aiClient: AIClientInterface, options: ExecutionOptions = {}): Promise<TestResult> {
  const runId = options.runId ?? generateRunId();
  const startedAt = new Date().toISOString();
  options.onTestStart?.(testCase);
  await testCaseRepo.put({ ...testCase, status: 'running' });

  let prevAttemptHadHealing = false;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) log.info(`Retry ${attempt + 1}/${MAX_RETRIES + 1} for "${testCase.title}"`);

    // Only force a fresh AI plan on attempt 2 if the previous attempt had healing activity.
    // If healing never triggered, replanning won't help (element simply doesn't exist).
    const freshPlan = attempt === 2 && prevAttemptHadHealing;
    const timeoutMultiplier = attempt === 1 ? 2 : 1;
    const { result, planHash, hadHealing } = await attemptExecution(page, testCase, aiClient, runId, startedAt, options, freshPlan, timeoutMultiplier, attempt);
    prevAttemptHadHealing = hadHealing;

    if (result.status === 'passed' || attempt === MAX_RETRIES) {
      await testResultRepo.put(result);
      await testCaseRepo.put({ ...testCase, status: result.status === 'passed' ? 'passed' : result.status === 'error' ? 'error' : 'failed' });
      // Mark plan as verified after a successful run so it never expires from cache
      if (result.status === 'passed' && planHash) {
        await planCacheRepo.markVerified(planHash).catch(() => {});
      }
      options.onTestComplete?.(result);
      return result;
    }

    if (testCase.startUrl) {
      const retryUrl = options.targetOrigin
        ? rewriteUrlIfSameOrigin(testCase.startUrl, testCase.startUrl, options.targetOrigin)
        : testCase.startUrl;
      try { await page.goto(retryUrl, { waitUntil: 'domcontentloaded' }); } catch {}
    }
  }

  throw new Error('Unexpected exit from execution loop');
}

async function attemptExecution(
  page: Page, testCase: TestCase, aiClient: AIClientInterface,
  runId: string, startedAt: string, options: ExecutionOptions,
  freshPlan: boolean, timeoutMultiplier: number, attempt: number
): Promise<{ result: TestResult; planHash?: string; hadHealing: boolean }> {
  if (testCase.startUrl) {
    const effectiveStartUrl = options.targetOrigin
      ? rewriteUrlIfSameOrigin(testCase.startUrl, testCase.startUrl, options.targetOrigin)
      : testCase.startUrl;
    if (options.targetOrigin && effectiveStartUrl !== testCase.startUrl) {
      log.info(`Origin rewrite: ${testCase.startUrl} → ${effectiveStartUrl}`);
    }
    try {
      await page.goto(effectiveStartUrl, { waitUntil: 'domcontentloaded' });
      // waitForFunction on readyState is more reliable than networkidle for SPAs
      await page.waitForFunction(() => document.readyState === 'complete', { timeout: 8000 }).catch(() => {});
      await delay(1500);
    } catch {}
  }

  // ── Determine planning mode for this attempt ──────────────────────────────
  const mode = options.planningMode ?? 'single-shot';
  const useInteractive = mode === 'interactive' || (mode === 'auto' && attempt === 0);

  let plan: ExecutionPlan;
  let planHash: string | undefined;

  if (useInteractive && !freshPlan) {
    // ── Interactive planning: walk the app step-by-step ────────────────────
    const goal = [testCase.title, testCase.description].filter(Boolean).join('. ');
    log.info(`Using interactive planning for "${testCase.title.slice(0, 60)}"`);

    let interactiveResult;
    try {
      interactiveResult = await interactivePlan(page, goal, aiClient);
    } catch (err) {
      log.warn(`Interactive planning threw, falling back to single-shot: ${err}`);
      interactiveResult = { steps: [], goalAchieved: false, stepsExecuted: 0 };
    }

    if (interactiveResult.steps.length === 0) {
      // Interactive planning failed completely — fall back to single-shot
      log.info(`Interactive planning produced no steps, falling back to single-shot`);
      try {
        let targetOrigin: string | undefined;
        try { targetOrigin = testCase.startUrl ? new URL(testCase.startUrl).origin : undefined; } catch {}
        plan = await planTest(testCase, aiClient, page, freshPlan, undefined, targetOrigin);
        planHash = plan.testCaseHash;
      } catch (err) {
        const screenshot = await screenshotPage(page).catch(() => undefined);
        return { result: buildErrorResult(testCase, runId, startedAt, String(err), screenshot), hadHealing: false };
      }
    } else {
      // Interactive plan succeeded — reset to startUrl for replay
      log.info(`Interactive planning produced ${interactiveResult.steps.length} verified steps`);
      if (testCase.startUrl) {
        const replayUrl = options.targetOrigin
          ? rewriteUrlIfSameOrigin(testCase.startUrl, testCase.startUrl, options.targetOrigin)
          : testCase.startUrl;
        try {
          await page.goto(replayUrl, { waitUntil: 'domcontentloaded' });
          await page.waitForFunction(() => document.readyState === 'complete', { timeout: 8000 }).catch(() => {});
          await delay(1500);
        } catch {}
      }
      plan = {
        id: generateId(),
        testCaseId: testCase.id,
        testCaseHash: '',
        steps: interactiveResult.steps,
        cachedAt: new Date().toISOString(),
      };
    }
  } else {
    // ── Single-shot planning ───────────────────────────────────────────────
    try {
      let targetOrigin: string | undefined;
      try { targetOrigin = testCase.startUrl ? new URL(testCase.startUrl).origin : undefined; } catch {}
      plan = await planTest(testCase, aiClient, page, freshPlan, undefined, targetOrigin);
      planHash = plan.testCaseHash;
    } catch (err) {
      const screenshot = await screenshotPage(page).catch(() => undefined);
      return { result: buildErrorResult(testCase, runId, startedAt, String(err), screenshot), hadHealing: false };
    }

    // Optional: validate + auto-repair selectors against the live start page
    if (options.validatePlan && plan.steps.length > 0) {
      try {
        const validation = await validateAndRepairPlan(page, plan.steps);
        if (validation.issues.length > 0) {
          log.info(`Plan validation: ${validation.issues.length} issues, ${validation.issues.filter(i => i.fixedSelector).length} repaired`);
          plan = { ...plan, steps: validation.repairedSteps };
        }
      } catch (err) {
        log.warn(`Plan validation failed (non-fatal): ${err}`);
      }
    }
  }

  // ── Execute the plan ──────────────────────────────────────────────────────

  // Apply origin rewrite to absolute navigate step values
  const rewrittenPlanSteps = (options.targetOrigin && testCase.startUrl)
    ? plan.steps.map((s) =>
        s.action === 'navigate' && s.value && s.value.startsWith('http')
          ? { ...s, value: rewriteUrlIfSameOrigin(s.value, testCase.startUrl!, options.targetOrigin!) }
          : s
      )
    : plan.steps;

  // Apply timing memory: if this page is known-slow, increase timeouts
  let memoryMultiplier = 1;
  try {
    const pageUrl = page.url();
    memoryMultiplier = await suggestTimeoutMultiplier(pageUrl, 10000);
  } catch {}
  const effectiveMultiplier = Math.max(timeoutMultiplier, memoryMultiplier);

  const steps = effectiveMultiplier === 1 ? rewrittenPlanSteps : rewrittenPlanSteps.map((s) => ({ ...s, timeout: (s.timeout ?? 10000) * effectiveMultiplier }));
  const stepResults: StepResult[] = [];
  let aborted = false;

  for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
    const step = steps[stepIndex];
    if (aborted || options.signal?.aborted) { stepResults.push({ step, status: 'skipped', duration: 0 }); continue; }

    await delay(getPostStepDelay(steps[stepIndex - 1], step));

    // Capture URL before step for AI assertion comparison
    const preStepUrl = options.useAIAssertions ? page.url() : '';
    const stepStart = Date.now();

    let result = await executeStepOnPage(page, step);

    if (result.status === 'failed' && step.selector) {
      const failScreenshot = await screenshotPage(page).catch(() => undefined);
      log.info(`Step ${step.order} failed — healing: ${step.selector}`);
      const healed = await healStep(page, step, result.error ?? '', aiClient);
      if (healed.success && healed.healedStep) {
        const retried = await executeStepOnPage(page, healed.healedStep);
        result = { ...retried, healingAttempt: healed.attempt };
        if (retried.status !== 'passed') { result.screenshot = failScreenshot; aborted = true; }
      } else {
        result = { ...result, healingAttempt: healed.attempt, screenshot: failScreenshot };
        aborted = true;
      }
    } else if (result.status === 'failed') {
      result.screenshot = await screenshotPage(page).catch(() => undefined);
      aborted = true;
    }

    result.duration = Date.now() - stepStart;
    stepResults.push(result);

    // Record timing to memory for future timeout adjustments
    try { await recordStepTiming(page.url(), result.duration); } catch {}

    options.onStepResult?.(testCase.id, step.order, result);

    // AI auto-assertions: after each passing step that changes state
    if (
      options.useAIAssertions &&
      result.status === 'passed' &&
      !aborted &&
      steps[stepIndex + 1]?.action !== 'assert'
    ) {
      try {
        const autoAssertion = await generatePostStepAssertion(page, step, preStepUrl, aiClient);
        if (autoAssertion) {
          const assertStep = assertionToStep(autoAssertion, step.order + 0.5);
          const assertResult = await executeStepOnPage(page, assertStep);
          assertResult.duration = 0;
          stepResults.push(assertResult);
          options.onStepResult?.(testCase.id, assertStep.order, assertResult);
          if (assertResult.status === 'failed') aborted = true;
        }
      } catch { /* non-fatal — AI assertions never block execution */ }
    }
  }

  const screenshot = aborted ? await screenshotPage(page).catch(() => undefined) : undefined;
  const healingAttempts = stepResults.filter((r) => r.healingAttempt).map((r) => r.healingAttempt!);

  // Visual diff: only run on passed tests — baselines on failures are meaningless
  let visualDiff: TestResult['visualDiff'] | undefined;
  if (!aborted) {
    try {
      const finalShot = await screenshotPage(page).catch(() => undefined);
      if (finalShot) {
        const vd = await compareWithBaseline(testCase.id, Buffer.from(finalShot, 'base64'));
        visualDiff = { diffPercent: vd.diffPercent, matches: vd.matches };
      }
    } catch {
      // Visual diff is best-effort — never block execution
    }
  }

  return {
    result: {
      id: generateId(), testCaseId: testCase.id, testCaseTitle: testCase.title,
      status: aborted ? 'failed' : 'passed', startedAt, completedAt: new Date().toISOString(),
      duration: Date.now() - new Date(startedAt).getTime(), steps: stepResults,
      screenshot, errorMessage: aborted ? stepResults.findLast((r) => r.error)?.error : undefined,
      healingAttempts, runId, visualDiff,
    },
    planHash,
    hadHealing: healingAttempts.length > 0,
  };
}

function getPostStepDelay(prev: ExecutionStep | undefined, cur: ExecutionStep): number {
  if (!prev) return 400;
  if (prev.action === 'navigate') return 1500;
  if ((prev.action === 'click' || prev.action === 'double_click') && (cur.action === 'assert' || cur.action === 'wait')) return 800;
  if (['type', 'clear', 'check', 'uncheck', 'select'].includes(prev.action)) return 200;
  return 300;
}

function buildErrorResult(tc: TestCase, runId: string, startedAt: string, error: string, screenshot?: string): TestResult {
  return {
    id: generateId(), testCaseId: tc.id, testCaseTitle: tc.title, status: 'error',
    startedAt, completedAt: new Date().toISOString(), duration: 0, steps: [],
    errorMessage: error, screenshot, healingAttempts: [], runId,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * If `url` shares the same origin as `sourceUrl`, replace its origin with
 * `targetOrigin`. URLs on a different origin are returned unchanged.
 */
function rewriteUrlIfSameOrigin(url: string, sourceUrl: string, targetOrigin: string): string {
  if (!url || !url.startsWith('http')) return url;
  try {
    const u = new URL(url);
    const src = new URL(sourceUrl);
    if (u.origin !== src.origin) return url;
    const tgt = new URL(targetOrigin);
    return tgt.origin + u.pathname + u.search + u.hash;
  } catch {
    return url;
  }
}
