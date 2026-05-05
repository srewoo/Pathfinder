import type { TestCase, TestResult, StepResult, ExecutionStep } from '../../storage/schemas';
import type { AIClientInterface } from '../ai/ai-client';
import { planTest } from '../planner/test-planner';
import type { PlanningMode } from '../planner/test-planner';
import { runStep, navigateTab } from './action-runner';
import { runStepWithCDP, initCDPSession, teardownCDPSession, getAXContext } from '../cdp/cdp-action-runner';
import { healStep, registerHealedSelector } from '../healing/self-healer';
import { getPageSnapshot } from '../explorer/page-scanner';
import { testCaseDB, testResultDB, planDB } from '../../storage/indexed-db';
import { getActiveTabId } from '../../messaging/messenger';
import { captureTab } from '../../utils/screenshot';
import { captureFullPageScreenshot } from '../cdp/cdp-client';
import { generateId, generateRunId } from '../../utils/hash';
import { createLogger } from '../../utils/logger';
import { generatePostStepAssertion, assertionToStep } from './assertion-generator';
import { ensureAuthenticated, recoverSessionIfExpired } from './auth-manager';
import { executeConditionalStep, executeLoopStep, executeCaptureValue, resolveStepVariables } from './step-extensions';
import { loadGraph as loadGraphForTimeout } from '../explorer/interaction-graph';

const log = createLogger('test-executor');

/**
 * 3 total attempts:
 *   Attempt 0 — original plan, normal timeouts
 *   Attempt 1 — same plan, doubled step timeouts (timing fix)
 *   Attempt 2 — fresh plan (selector fix)
 */
const MAX_TEST_RETRIES = 2;

export interface ExecutionOptions {
  onStepResult?: (testCaseId: string, stepOrder: number, result: StepResult) => void;
  onTestStart?: (testCase: TestCase) => void;
  onTestComplete?: (result: TestResult) => void;
  runId?: string;
  rerunAll?: boolean;
  /**
   * Number of tests to run concurrently. Each concurrent test gets its own
   * browser tab. Default is 1 (sequential). Max is 4.
   */
  concurrency?: number;
  /** Run only the specified test case IDs, preserving the given order. */
  testCaseIds?: string[];
  /** Use CDP trusted events for action dispatch (default: true). */
  useCDP?: boolean;
  /** Planning strategy for test step generation (default: 'auto'). */
  planningMode?: PlanningMode;
  /**
   * When true, generate AI assertions from live DOM after key steps (navigate, click, select).
   * Adds one lightweight AI call per qualifying step. Default false.
   */
  useAIAssertions?: boolean;
  /** AbortSignal to stop the test run early. */
  signal?: AbortSignal;
  /**
   * When set, replace the explored app's origin with this target origin at
   * runtime (e.g. switch integration → staging). Rewrites testCase.startUrl
   * and any absolute navigate step values — stored data is never modified.
   */
  targetOrigin?: string;
}

// ---------------------------------------------------------------------------
// Execute a single test case
// ---------------------------------------------------------------------------
export async function executeTest(
  testCase: TestCase,
  aiClient: AIClientInterface,
  tabId: number,
  options: ExecutionOptions = {}
): Promise<TestResult> {
  const { runId = generateRunId(), useCDP = true } = options;
  const startedAt = new Date().toISOString();

  options.onTestStart?.(testCase);
  await testCaseDB.put({ ...testCase, status: 'running' });

  // Initialize CDP session for trusted event dispatch + HAR capture
  let cdpActive = false;
  if (useCDP) {
    cdpActive = await initCDPSession(tabId);
  }

  try {
  for (let attempt = 0; attempt <= MAX_TEST_RETRIES; attempt++) {
    if (attempt > 0) {
      log.info(`Retrying test "${testCase.title}" (attempt ${attempt + 1}/${MAX_TEST_RETRIES + 1})`);
    }

    // Attempt 0: normal plan, 1x timeout
    // Attempt 1: reuse plan, 2x timeout (timing fix)
    // Attempt 2: fresh plan, 1x timeout (selector fix)
    const freshPlan = attempt === 2;
    const timeoutMultiplier = attempt === 1 ? 2 : 1;

    const result = await attemptExecution(testCase, aiClient, tabId, runId, startedAt, { ...options, cdpActive }, freshPlan, timeoutMultiplier);

    if (result.status === 'passed' || attempt === MAX_TEST_RETRIES) {
      // Attach HAR entries to the result for network-level debugging
      if (cdpActive) {
        const harEntries = await teardownCDPSession(tabId);
        cdpActive = false;
        if (harEntries.length > 0) {
          (result as any).harEntries = harEntries;
        }
      }
      await finalizeResult(testCase, result);
      options.onTestComplete?.(result);
      return result;
    }

    if (testCase.startUrl) {
      const retryUrl = options.targetOrigin
        ? rewriteUrlIfSameOrigin(testCase.startUrl, testCase.startUrl, options.targetOrigin)
        : testCase.startUrl;
      try {
        await navigateTab(tabId, retryUrl);
      } catch (navErr) {
        log.warn('Failed to reset to start URL before retry', navErr);
      }
    }
  }

  throw new Error('Unexpected exit from execution loop');
  } finally {
    // Ensure CDP is cleaned up even on unexpected errors
    if (cdpActive) {
      await teardownCDPSession(tabId).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Execute all pending test cases — supports parallel execution via tab pool
// ---------------------------------------------------------------------------
export async function executeAllTests(
  aiClient: AIClientInterface,
  options: ExecutionOptions = {}
): Promise<TestResult[]> {
  const { concurrency = 1 } = options;
  const runId = generateRunId();

  const allTests = await testCaseDB.getAll();
  const toRun = selectTestsToRun(allTests, options);

  if (toRun.length === 0) {
    log.info('No pending tests to run');
    return [];
  }

  const effectiveConcurrency = Math.max(1, Math.min(4, concurrency));
  log.info(`Starting run: ${toRun.length} tests, concurrency=${effectiveConcurrency}`);

  if (effectiveConcurrency === 1) {
    return runSequential(toRun, aiClient, { ...options, runId });
  }

  return runParallel(toRun, aiClient, { ...options, runId }, effectiveConcurrency);
}

// ---------------------------------------------------------------------------
// Sequential runner (original behaviour)
// ---------------------------------------------------------------------------
async function runSequential(
  tests: TestCase[],
  aiClient: AIClientInterface,
  options: ExecutionOptions
): Promise<TestResult[]> {
  const tabId = await getActiveTabId();
  const suiteStartUrl = await getCurrentTabUrl(tabId);
  const results: TestResult[] = [];

  for (let i = 0; i < tests.length; i++) {
    if (options.signal?.aborted) break;
    const tc = tests[i];
    log.info(`[${i + 1}/${tests.length}] Executing: "${tc.title}"`);

    const rawResetUrl = tc.startUrl ?? suiteStartUrl;
    const resetUrl = (options.targetOrigin && rawResetUrl && tc.startUrl)
      ? rewriteUrlIfSameOrigin(rawResetUrl, tc.startUrl, options.targetOrigin)
      : rawResetUrl;
    if (resetUrl) {
      try { await navigateTab(tabId, resetUrl); } catch { /* non-fatal */ }
    }

    const result = await executeTest(tc, aiClient, tabId, options);
    results.push(result);
  }

  log.info(`Run complete: ${results.filter((r) => r.status === 'passed').length}/${results.length} passed`);
  return results;
}

// ---------------------------------------------------------------------------
// Parallel runner — opens N tabs, distributes tests across a shared queue
// ---------------------------------------------------------------------------
async function runParallel(
  tests: TestCase[],
  aiClient: AIClientInterface,
  options: ExecutionOptions,
  concurrency: number
): Promise<TestResult[]> {
  const primaryTabId = await getActiveTabId();
  const primaryTab = await chrome.tabs.get(primaryTabId);
  const suiteStartUrl = primaryTab.url;

  // Open additional tabs (concurrency - 1 extras; the primary tab is slot 0)
  const tabIds: number[] = [primaryTabId];
  const extraTabIds: number[] = [];

  for (let i = 1; i < concurrency; i++) {
    try {
      const tab = await chrome.tabs.create({
        url: suiteStartUrl ?? 'about:blank',
        active: false,
      });
      if (tab.id !== undefined) {
        tabIds.push(tab.id);
        extraTabIds.push(tab.id);
      }
    } catch (err) {
      log.warn(`Could not open tab ${i + 1} for parallel execution`, err);
      break;
    }
  }

  log.info(`Parallel run: ${tests.length} tests across ${tabIds.length} tabs`);

  // Shared work queue — each worker pops from the front
  const queue = [...tests];
  const results: TestResult[] = [];

  const workers = tabIds.map(async (tabId) => {
    while (true) {
      if (options.signal?.aborted) break;
      const tc = queue.shift();
      if (!tc) break;

      const rawResetUrl = tc.startUrl ?? suiteStartUrl;
      const resetUrl = (options.targetOrigin && rawResetUrl && tc.startUrl)
        ? rewriteUrlIfSameOrigin(rawResetUrl, tc.startUrl, options.targetOrigin)
        : rawResetUrl;
      if (resetUrl) {
        try { await navigateTab(tabId, resetUrl); } catch { /* non-fatal */ }
      }

      const result = await executeTest(tc, aiClient, tabId, options);
      results.push(result);
    }
  });

  await Promise.all(workers);

  // Clean up extra tabs
  for (const tabId of extraTabIds) {
    try { await chrome.tabs.remove(tabId); } catch { /* tab may already be closed */ }
  }

  log.info(`Parallel run complete: ${results.filter((r) => r.status === 'passed').length}/${results.length} passed`);
  return results;
}

// ---------------------------------------------------------------------------
// Internal: run one attempt of a test
// ---------------------------------------------------------------------------
async function attemptExecution(
  testCase: TestCase,
  aiClient: AIClientInterface,
  tabId: number,
  runId: string,
  startedAt: string,
  options: ExecutionOptions & { cdpActive?: boolean },
  freshPlan: boolean,
  timeoutMultiplier: number
): Promise<TestResult> {
  // ── Auth setup: inject cookies and verify session before test ──
  if (testCase.requiresAuthenticatedSession && testCase.executionPresetId) {
    const authResult = await ensureAuthenticated(tabId, testCase.executionPresetId, testCase.startUrl);
    if (!authResult.authenticated) {
      log.warn(`Auth setup failed (method: ${authResult.method}) — proceeding anyway`);
    } else {
      log.info(`Auth verified via ${authResult.method}`);
    }
  }

  // Always navigate to startUrl before planning so the DOM snapshot is correct.
  // Apply origin rewrite at runtime if targetOrigin is set — stored data unchanged.
  if (testCase.startUrl) {
    const effectiveStartUrl = options.targetOrigin
      ? rewriteUrlIfSameOrigin(testCase.startUrl, testCase.startUrl, options.targetOrigin)
      : testCase.startUrl;
    if (options.targetOrigin && effectiveStartUrl !== testCase.startUrl) {
      log.info(`Origin rewrite: ${testCase.startUrl} → ${effectiveStartUrl}`);
    }
    try {
      await navigateTab(tabId, effectiveStartUrl);
      await delay(2000); // wait for SPA to render
    } catch (navErr) {
      log.warn('Failed to navigate to startUrl before test', navErr);
    }
  }

  // When CDP is active, get accessibility tree for richer planning context
  let axContext: string | undefined;
  if (options.cdpActive) {
    try {
      axContext = await getAXContext(tabId);
    } catch {
      // Non-fatal — planning works without accessibility tree
    }
  }

  let plan;
  try {
    plan = await planTest(testCase, aiClient, tabId, freshPlan, axContext ? { accessibilityContext: axContext } : undefined, options.planningMode ?? 'auto');
  } catch (err) {
    const [screenshot, snapshot] = await Promise.all([
      captureTab(tabId).catch(() => undefined),
      getPageSnapshot(tabId).catch(() => null),
    ]);
    return buildErrorResult(
      testCase,
      runId,
      startedAt,
      String(err),
      screenshot,
      snapshot?.domCompressed
    );
  }

  // Apply origin rewrite to absolute navigate step values
  const rewrittenSteps = (options.targetOrigin && testCase.startUrl)
    ? plan.steps.map((s) =>
        s.action === 'navigate' && s.value && s.value.startsWith('http')
          ? { ...s, value: rewriteUrlIfSameOrigin(s.value, testCase.startUrl!, options.targetOrigin!) }
          : s
      )
    : plan.steps;

  // Apply adaptive timeouts from exploration data + retry multiplier.
  // For navigate steps, if we have observed load time for the target page,
  // use 2x that time (with a 5s floor) instead of the generic 10s default.
  const explorationGraph = await loadGraphForTimeout().catch(() => undefined);
  const pageLoadTimes = new Map<string, number>();
  if (explorationGraph) {
    for (const node of explorationGraph.nodes) {
      if (node.loadTimeMs) pageLoadTimes.set(node.url, node.loadTimeMs);
    }
  }

  const steps = rewrittenSteps.map((s) => {
    let timeout = s.timeout ?? 10000;
    // For navigate steps, use observed page load time if available
    if (s.action === 'navigate' && s.value) {
      const observed = pageLoadTimes.get(s.value);
      if (observed) {
        timeout = Math.max(5000, observed * 2); // 2x observed with 5s floor
      }
    }
    return { ...s, timeout: timeout * timeoutMultiplier };
  });

  const stepResults: StepResult[] = [];
  let aborted = false;
  let previousStep: ExecutionStep | undefined;
  const capturedValues = new Map<string, string>();

  for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
    const step = steps[stepIndex];
    if (aborted || options.signal?.aborted) {
      stepResults.push({ step, status: 'skipped', duration: 0 });
      continue;
    }

    // Capture URL before step for assertion generator context
    const preStepUrl = options.useAIAssertions
      ? await getPageSnapshot(tabId).then((s) => s?.url ?? '').catch(() => '')
      : '';

    // Adaptive delay based on previous step type
    await delay(getPostStepDelay(previousStep, step));

    const stepStart = Date.now();

    // Handle extended action types (conditional, loop, capture)
    if (step.action === 'if_visible' || step.action === 'loop' || step.action === 'capture_value' || step.action === 'use_captured') {
      const extResult = await executeExtendedStep(step, tabId, capturedValues, options.cdpActive ? runStepWithCDP : runStep);
      extResult.duration = Date.now() - stepStart;
      stepResults.push(extResult);
      options.onStepResult?.(testCase.id, step.order, extResult);
      previousStep = step;
      if (extResult.status === 'failed') aborted = true;
      continue;
    }

    // Resolve captured variables in step values
    const resolvedStep = resolveStepVariables(step, capturedValues);

    // Use CDP trusted events when available, fall back to synthetic
    const executeStep = options.cdpActive ? runStepWithCDP : runStep;
    let result = await executeStep(resolvedStep, tabId);

    if (result.status === 'failed' && step.selector) {
      // ── Mid-test session recovery: check if failure is auth-related ──
      // If session expired, re-authenticate and retry the step before healing.
      const sessionRecovered = await recoverSessionIfExpired(
        tabId,
        testCase.executionPresetId,
        testCase.startUrl,
        result.error ?? ''
      );
      if (sessionRecovered) {
        log.info(`Session recovered — retrying step ${step.order}`);
        const retryAfterAuth = await (options.cdpActive ? runStepWithCDP : runStep)(resolvedStep, tabId);
        if (retryAfterAuth.status === 'passed') {
          result = retryAfterAuth;
          result.duration = Date.now() - stepStart;
          stepResults.push(result);
          options.onStepResult?.(testCase.id, step.order, result);
          previousStep = step;
          continue;
        }
        // Still failed after re-auth — fall through to healing
      }

      // ── Per-action quick retry with backoff ──────────────────────────────
      // Many transient failures (element not yet rendered, animation in progress)
      // resolve with a short delay. Try once more before expensive healing.
      {
        const retryDelay = Math.min(1500, (step.timeout ?? 10000) * 0.15);
        await new Promise((r) => setTimeout(r, retryDelay));
        const quickRetry = await (options.cdpActive ? runStepWithCDP : runStep)(resolvedStep, tabId);
        if (quickRetry.status === 'passed') {
          result = quickRetry;
          result.duration = Date.now() - stepStart;
          stepResults.push(result);
          options.onStepResult?.(testCase.id, step.order, result);
          previousStep = step;
          continue;
        }
      }

      // Capture screenshot at exact moment of failure (before healing changes state)
      const failScreenshot = await captureTab(tabId).catch(() => undefined);

      log.info(`Step ${step.order} failed — attempting healing for: ${step.selector}`);
      const healed = await healStep(step, result.error ?? '', tabId, aiClient);

      if (healed.success && healed.healedStep) {
        const retriedResult = await runStep(healed.healedStep, tabId);
        result = { ...retriedResult, healingAttempt: healed.attempt };
        if (retriedResult.status === 'passed') {
          log.info(`Healing succeeded via ${healed.attempt.method}: ${healed.attempt.healedSelector}`);
          // Register in cross-test healing registry so other tests benefit
          if (healed.attempt.healedSelector && step.selector) {
            registerHealedSelector(step.selector, healed.attempt.healedSelector);
          }
          // Persist the healed selector back to the cached execution plan
          // so the same test doesn't re-break on the next run.
          if (healed.attempt.healedSelector) {
            try {
              const cachedPlan = await planDB.getByTestCaseId(testCase.id);
              if (cachedPlan) {
                const planStep = cachedPlan.steps.find((s) => s.order === step.order);
                if (planStep) {
                  planStep.selector = healed.attempt.healedSelector;
                  await planDB.put(cachedPlan);
                  log.info(`Persisted healed selector to plan for step ${step.order}`);
                }
              }
            } catch (err) {
              log.debug('Failed to persist healed selector to plan', err);
            }
          }
        } else {
          // Healing found a selector but step still failed — attach screenshot
          result.screenshot = failScreenshot;
          aborted = true;
        }
      } else {
        result = { ...result, healingAttempt: healed.attempt, screenshot: failScreenshot };
        aborted = true;
      }
    } else if (result.status === 'failed') {
      // No selector to heal — capture screenshot and abort
      result.screenshot = await captureTab(tabId).catch(() => undefined);
      log.warn(`Step ${step.order} failed (no selector to heal): ${result.error}`);
      aborted = true;
    }

    result.duration = Date.now() - stepStart;
    stepResults.push(result);
    options.onStepResult?.(testCase.id, step.order, result);
    previousStep = step;

    // Auto-generate assertion from live DOM after key steps (when enabled and step passed)
    if (options.useAIAssertions && result.status === 'passed') {
      const nextStep = steps[stepIndex + 1];
      const nextIsAssert = nextStep?.action === 'assert';
      if (!nextIsAssert) {
        const assertion = await generatePostStepAssertion(tabId, step, preStepUrl, aiClient).catch(() => null);
        if (assertion) {
          const autoStep = assertionToStep(assertion, step.order + 0.5);
          const executeStep = options.cdpActive ? runStepWithCDP : runStep;
          const assertResult = await executeStep(autoStep, tabId).catch(() => null);
          if (assertResult) {
            assertResult.duration = assertResult.duration ?? 0;
            stepResults.push(assertResult);
            options.onStepResult?.(testCase.id, autoStep.order, assertResult);
          }
        }
      }
    }
  }

  const finalStatus = aborted ? 'failed' : 'passed';
  const [screenshot, snapshot] = finalStatus === 'failed'
    ? await Promise.all([
        // Prefer CDP full-page screenshot when available
        (options.cdpActive
          ? captureFullPageScreenshot(tabId).catch(() => captureTab(tabId).catch(() => undefined))
          : captureTab(tabId).catch(() => undefined)
        ),
        getPageSnapshot(tabId).catch(() => null),
      ])
    : [undefined, null] as const;

  return {
    id: generateId(),
    testCaseId: testCase.id,
    testCaseTitle: testCase.title,
    status: finalStatus,
    startedAt,
    completedAt: new Date().toISOString(),
    duration: Date.now() - new Date(startedAt).getTime(),
    steps: stepResults,
    screenshot,
    domSnapshot: snapshot?.domCompressed,
    errorMessage: aborted ? stepResults.findLast((r) => r.error)?.error : undefined,
    healingAttempts: stepResults.filter((r) => r.healingAttempt).map((r) => r.healingAttempt!),
    runId,
  };
}

// ---------------------------------------------------------------------------
// Adaptive step delay — returns ms to wait based on previous step type
// ---------------------------------------------------------------------------
function getPostStepDelay(previousStep: ExecutionStep | undefined, currentStep: ExecutionStep): number {
  if (!previousStep) return 400; // first step

  switch (previousStep.action) {
    case 'navigate':
      return 1500;
    case 'click':
    case 'double_click':
      // Longer delay before assertions/waits (action result needs to settle)
      return (currentStep.action === 'assert' || currentStep.action === 'wait') ? 800 : 400;
    case 'type':
    case 'clear':
    case 'check':
    case 'uncheck':
    case 'select':
      return 200;
    case 'assert':
    case 'wait':
    case 'scroll':
    case 'hover':
      return 100;
    default:
      return 400;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function finalizeResult(testCase: TestCase, result: TestResult): Promise<void> {
  await testResultDB.put(result);
  await testCaseDB.put({
    ...testCase,
    status: result.status === 'passed' ? 'passed' : result.status === 'error' ? 'error' : 'failed',
  });
}

function buildErrorResult(
  testCase: TestCase,
  runId: string,
  startedAt: string,
  error: string,
  screenshot?: string,
  domSnapshot?: string
): TestResult {
  return {
    id: generateId(),
    testCaseId: testCase.id,
    testCaseTitle: testCase.title,
    status: 'error',
    startedAt,
    completedAt: new Date().toISOString(),
    duration: 0,
    steps: [],
    errorMessage: error,
    screenshot,
    domSnapshot,
    healingAttempts: [],
    runId,
  };
}

async function getCurrentTabUrl(tabId: number): Promise<string | undefined> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab.url;
  } catch {
    return undefined;
  }
}

async function executeExtendedStep(
  step: ExecutionStep,
  tabId: number,
  capturedValues: Map<string, string>,
  stepRunner: typeof runStep
): Promise<StepResult> {
  try {
    if (step.action === 'if_visible') {
      return await executeConditionalStep(step, tabId, capturedValues, stepRunner);
    }
    if (step.action === 'loop') {
      return await executeLoopStep(step, tabId, capturedValues, stepRunner);
    }
    if (step.action === 'capture_value') {
      return await executeCaptureValue(step, tabId, capturedValues);
    }
    if (step.action === 'use_captured') {
      // use_captured is resolved inline via resolveStepVariables — should not reach here
      return { step, status: 'passed', duration: 0 };
    }
    return { step, status: 'skipped', duration: 0 };
  } catch (err) {
    return { step, status: 'failed', duration: 0, error: String(err) };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * If `url` has the same origin as `sourceUrl`, replace its origin with
 * `targetOrigin`.  Any URL on a different origin (external links, auth
 * providers) is returned unchanged.
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

function selectTestsToRun(testCases: TestCase[], options: ExecutionOptions): TestCase[] {
  if (options.testCaseIds && options.testCaseIds.length > 0) {
    const byId = new Map(testCases.map((testCase) => [testCase.id, testCase]));
    return options.testCaseIds
      .map((id) => byId.get(id))
      .filter((testCase): testCase is TestCase => Boolean(testCase));
  }

  return options.rerunAll
    ? testCases
    : testCases.filter((tc) => tc.status === 'pending' || tc.status === 'error');
}
