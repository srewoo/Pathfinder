import type {
  AttemptRecord,
  TestCase,
  TestResult,
  StepResult,
  ExecutionStep,
} from '../../storage/schemas';
import type { PlanningMode } from '../planner/test-planner';
import type { ExecutionServices } from './execution-ports';
import { runStep, navigateTab } from './action-runner';
import { initCDPSession, teardownCDPSession, getAXContext } from '../cdp/cdp-session';
import { registerHealedSelector } from '../healing/self-healer';
import { dataRowLabel, rowVariables } from '../test-gen/dataset';
import { getPageSnapshot } from '../explorer/page-scanner';
import { testCaseDB, testResultDB, planDB } from '../../storage/indexed-db';
import { getActiveTabId } from '../../messaging/messenger';
import { captureTab } from '../../utils/screenshot';
import { captureFullPageScreenshot, isAttached, waitForNetworkIdle, waitForDomSettle } from '../cdp/cdp-client';
import { generateId, generateRunId } from '../../utils/hash';
import { dominantOrigin, schemaFindingsForResult } from '../analysis/schema-oracle';
import { loadBaseline } from '../../storage/api-baseline-storage';
import { retainBodies } from '../../storage/response-body-store';
import { createLogger } from '../../utils/logger';
import { describeIsolation, isolateBeforeTest, type IsolationLevel } from './test-isolation';
import { captureState, diffState, type StateSnapshot } from '../analysis/state-diff';
import { evaluateIrPath, executeViaIr, explainPathChoice } from './ir-execution-path';
import { runStateOracles } from '../analysis/state-oracles';

import { driverForTab, evaluateInTab } from '../step-executor';
import { ensureAuthenticated, recoverSessionIfExpired } from './auth-manager';
import { executeConditionalStep, executeLoopStep, executeCaptureValue, resolveStepVariables } from './step-extensions';
import { loadGraph as loadGraphForTimeout } from '../explorer/interaction-graph';
import { configureBudget, BudgetExceededError } from '../budget/budget-guard';

const log = createLogger('test-executor');

/**
 * 3 total attempts:
 *   Attempt 0 — original plan, normal timeouts
 *   Attempt 1 — same plan, doubled step timeouts (timing fix)
 *   Attempt 2 — fresh plan (selector fix)
 */
import {
  authoringConfidence,
  buildErrorMessage,
  getPostStepDelay,
  isMutatingStep,
  isSubmitStep,
  recordAttempt,
} from './execution-decisions';

const MAX_TEST_RETRIES = 2;

export interface ExecutionOptions {
  /**
   * Client-state isolation between tests. Default 'reset'.
   *
   * Concurrent tests share a browser profile, so without a scrub one test's
   * leftover storage becomes another's starting state — and the resulting failure
   * looks like a product bug rather than cross-talk.
   */
  isolation?: IsolationLevel;
  /** Extra storage keys to preserve across the scrub (e.g. a custom token key). */
  preserveStorageKeys?: RegExp[];
  /**
   * Execute through the validated `TestIR` path rather than the legacy step walker.
   *
   * Default false. The IR path is fully deterministic and schema-gated, but does
   * not yet carry self-healing, the retry ladder or auth recovery — so it is opted
   * into rather than assumed, and it declines automatically when a plan cannot
   * convert without loss.
   */
  useIrPath?: boolean;
  /**
   * Run the state-diff oracles during execution. Default true.
   *
   * Costs two page snapshots per mutating step, and buys findings the test's own
   * assertions structurally cannot make.
   */
  stateOracles?: boolean;
  /**
   * Extra origins this run may reach beyond the test's own (fix.md §7) — a
   * separate API host, for example. Opt-in only; never inferred, because a
   * wrongly-widened allowlist fails silently.
   */
  allowedOrigins?: string[];
  /**
   * Permit mutating HTTP verbs (POST/PUT/PATCH/DELETE). Default false: running a
   * saved test is not by itself permission to write to the target.
   */
  allowMutations?: boolean;
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
   * USD spend cap for the whole run. When set, AI calls (planning, healing,
   * assertions) refuse once the cap is hit, stopping a runaway suite instead
   * of silently accumulating cost. null/undefined disables enforcement.
   */
  budgetUsd?: number | null;
  /**
   * Hard per-test wall-clock ceiling in ms. A test exceeding it is aborted and
   * marked failed, preventing a single hung test from stalling the whole run.
   * Default 300_000 (5 min).
   */
  maxTestDurationMs?: number;
  /**
   * When set, replace the explored app's origin with this target origin at
   * runtime (e.g. switch integration → staging). Rewrites testCase.startUrl
   * and any absolute navigate step values — stored data is never modified.
   */
  targetOrigin?: string;
  /**
   * Begin at this step order, recording every earlier step as `skipped`.
   *
   * For debugging a long scenario: replaying 27 steps to reach step 28 is the
   * slowest part of the authoring loop. Earlier steps are marked SKIPPED, never
   * passed — a resumed run must not claim it verified something it did not
   * execute, or the result is a false green.
   */
  startFromStep?: number;
  /**
   * Row of `testCase.dataSet` this run uses.
   *
   * Its columns are seeded into the captured-variable map before the step walk,
   * so `{{column}}` resolves through the existing substitution path rather than
   * a parallel one.
   */
  dataRowIndex?: number;
}

// ---------------------------------------------------------------------------
// Execute a single test case
// ---------------------------------------------------------------------------
export async function executeTest(
  testCase: TestCase,
  services: ExecutionServices,
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
    // Scope request enforcement to this test's own origin (fix.md §7). Tests are
    // read-only with respect to the network unless a run explicitly opts in —
    // executing a saved test is not, by itself, permission to mutate.
    cdpActive = await initCDPSession(tabId, {
      startUrl: testCase.startUrl,
      extraOrigins: options.allowedOrigins,
      allowMutations: options.allowMutations === true,
      additionalUrls: options.targetOrigin ? [options.targetOrigin] : undefined,
    });
  }

  try {
  // Every attempt, kept so a fail-then-pass can explain itself. Only the last
  // result is returned, and discarding the rest threw away the clearest signal
  // the run produces about a flaky test.
  const attemptLedger: AttemptRecord[] = [];

  for (let attempt = 0; attempt <= MAX_TEST_RETRIES; attempt++) {
    if (attempt > 0) {
      log.info(`Retrying test "${testCase.title}" (attempt ${attempt + 1}/${MAX_TEST_RETRIES + 1})`);
    }

    // Attempt 0: normal plan, 1x timeout
    // Attempt 1: reuse plan, 2x timeout (timing fix)
    // Attempt 2: fresh plan, 1x timeout (selector fix)
    const freshPlan = attempt === 2;
    const timeoutMultiplier = attempt === 1 ? 2 : 1;

    const result = await attemptExecution(testCase, services, tabId, runId, startedAt, { ...options, cdpActive }, freshPlan, timeoutMultiplier);
    attemptLedger.push(recordAttempt(result, attempt, freshPlan, timeoutMultiplier));

    // Stop on success, after the last attempt, or once aborted (per-test ceiling
    // / user stop) — don't burn further attempts on a test we've abandoned.
    if (result.status === 'passed' || attempt === MAX_TEST_RETRIES || options.signal?.aborted) {
      // Only when it took more than one go — a first-attempt pass needs no
      // ledger, and storing a single-entry one on every result is noise.
      if (attemptLedger.length > 1) result.attempts = attemptLedger;
      // Attach HAR entries to the result for network-level debugging
      if (cdpActive) {
        const harEntries = await teardownCDPSession(tabId);
        cdpActive = false;
        if (harEntries.length > 0) {
          // Project the rich CDP HAR shape onto the persisted subset.
          result.harEntries = harEntries.map((e) => ({
            url: e.url,
            method: e.method,
            status: e.status,
            statusText: e.statusText,
            mimeType: e.mimeType,
            duration: e.duration,
            bodySize: e.bodySize,
            // The request body (needed for GraphQL operation identity) and the
            // response SCHEMA survive the projection now. The response body never
            // does — see ADR 001.
            requestBody: e.requestBody,
            responseSchema: e.responseSchema,
          }));

          // A breaking schema change on an endpoint THIS test called becomes a
          // finding, so the existing verdict path downgrades PASS → NEEDS_REVIEW.
          // Without this a test asserts on a UI that still renders while the contract
          // behind it broke, and reports green (ADR 001 phase 3).
          try {
            const origin = dominantOrigin(result.harEntries);
            const baseline = origin ? await loadBaseline(origin) : undefined;
            const findings = schemaFindingsForResult(result.harEntries, baseline, origin);
            if (findings.length > 0) {
              result.oracleFindings = [...(result.oracleFindings ?? []), ...findings];
              log.warn(
                `${findings.length} endpoint(s) changed shape since the baseline during ` +
                  `"${testCase.title}" — verdict downgraded to NEEDS_REVIEW.`
              );
            }
          } catch (err) {
            // Never fail a test over its own analysis.
            log.debug('Schema baseline comparison failed', err);
          }

          // Redacted bodies, when the debug setting is on. Stored apart from the
          // result so exports stay clean and the 24h TTL is enforceable.
          try {
            const retained = harEntries
              .filter((e) => e.redactedBody)
              .map((e) => ({
                url: e.url,
                method: e.method,
                status: e.status,
                body: e.redactedBody!.body,
                redactedCount: e.redactedBody!.redactedCount,
                truncated: e.redactedBody!.truncated,
                capturedAt: Date.now(),
              }));
            if (retained.length > 0) await retainBodies(result.runId, retained);
          } catch (err) {
            log.debug('Could not retain response bodies', err);
          }
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
  services: ExecutionServices,
  options: ExecutionOptions = {}
): Promise<TestResult[]> {
  const { concurrency = 1 } = options;
  const runId = generateRunId();

  // Apply the per-run spend cap (no-op when budgetUsd is null/undefined).
  if (options.budgetUsd !== undefined) {
    configureBudget({
      limitUsd: options.budgetUsd,
      onExceeded: (info) => log.warn(`AI budget cap hit: $${info.spentUsd.toFixed(4)} of $${info.limitUsd?.toFixed(2)} — stopping run.`),
    });
  }

  const allTests = await testCaseDB.getAll();
  const selected = selectTestsToRun(allTests, options);
  // Selecting a test by id is an explicit choice, so it overrides quarantine.
  // A suite run does not.
  const toRun = expandDataDrivenCases(selected, {
    includeQuarantined: Boolean(options.testCaseIds?.length),
  });

  if (toRun.length === 0) {
    log.info('No pending tests to run');
    return [];
  }

  const effectiveConcurrency = Math.max(1, Math.min(4, concurrency));
  log.info(`Starting run: ${toRun.length} run(s), concurrency=${effectiveConcurrency}`);

  if (effectiveConcurrency === 1) {
    return runSequential(toRun, services, { ...options, runId });
  }

  return runParallel(toRun, services, { ...options, runId }, effectiveConcurrency);
}

/**
 * Steps below `startFromStep`, recorded as skipped.
 *
 * Skipped, never passed. A resumed run that reported its prefix as passing
 * would be a false green — it would claim to have verified steps it never
 * executed, which is the one thing a test result must never do.
 */
export function skippedPrefix(
  steps: readonly ExecutionStep[],
  startFromStep: number
): StepResult[] {
  if (startFromStep <= 0) return [];
  return [...steps]
    .sort((a, b) => a.order - b.order)
    .filter((step) => step.order < startFromStep)
    .map((step) => ({
      step,
      status: 'skipped' as const,
      duration: 0,
      error: `Skipped — run resumed from step ${startFromStep}`,
    }));
}

/**
 * Placeholder names a step still carries after substitution.
 *
 * Only meaningful for a resumed run: in a full run the IR validator has already
 * guaranteed every placeholder is captured by an earlier step.
 */
export function unresolvedPlaceholders(step: ExecutionStep): string[] {
  const names = new Set<string>();
  for (const text of [step.value, step.assertExpected]) {
    if (!text) continue;
    for (const match of text.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
      names.add(match[1]);
    }
  }
  return [...names];
}

// ---------------------------------------------------------------------------
// Data-driven fan-out
// ---------------------------------------------------------------------------

export interface DataRun {
  testCase: TestCase;
  dataRowIndex?: number;
  /** Title as it should appear in results — carries the row for a data run. */
  label: string;
}

/**
 * Result title for a run, naming the data row when there is one.
 *
 * Three results all called "User can sign in" are indistinguishable in the
 * results list, which defeats the point of running the scenario per row.
 */
function resultTitle(testCase: TestCase, dataRowIndex?: number): string {
  if (!testCase.dataSet || dataRowIndex === undefined) return testCase.title;
  return `${testCase.title} [${dataRowLabel(testCase.dataSet, dataRowIndex)}]`;
}

/**
 * One entry per actual run: a plain test yields one, a test with N data rows
 * yields N.
 *
 * Quarantined tests are dropped here so every caller of the suite runner
 * inherits the exclusion rather than each remembering it — except when the user
 * selected the test explicitly, which is an override, not an oversight.
 */
export function expandDataDrivenCases(
  testCases: readonly TestCase[],
  opts: { includeQuarantined?: boolean } = {}
): DataRun[] {
  const runs: DataRun[] = [];

  for (const testCase of testCases) {
    if (testCase.quarantined && !opts.includeQuarantined) continue;

    const rowCount = testCase.dataSet?.rows.length ?? 0;
    if (!testCase.dataSet || rowCount === 0) {
      runs.push({ testCase, label: testCase.title });
      continue;
    }
    for (let i = 0; i < rowCount; i++) {
      runs.push({
        testCase,
        dataRowIndex: i,
        label: `${testCase.title} [${dataRowLabel(testCase.dataSet, i)}]`,
      });
    }
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Run one test with a hard wall-clock ceiling. Combines the run-level signal
// with a per-test timeout so a single hung test can't stall the whole run.
// ---------------------------------------------------------------------------
async function executeTestBounded(
  testCase: TestCase,
  services: ExecutionServices,
  tabId: number,
  options: ExecutionOptions,
): Promise<TestResult> {
  const ceiling = options.maxTestDurationMs ?? 300_000;
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', onParentAbort, { once: true });
  }
  const timer = setTimeout(() => {
    log.warn(`Test "${testCase.title}" exceeded ${ceiling}ms ceiling — aborting.`);
    controller.abort();
  }, ceiling);

  try {
    return await executeTest(testCase, services, tabId, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onParentAbort);
  }
}

// ---------------------------------------------------------------------------
// Sequential runner (original behaviour)
// ---------------------------------------------------------------------------
async function runSequential(
  runs: DataRun[],
  services: ExecutionServices,
  options: ExecutionOptions
): Promise<TestResult[]> {
  const tabId = await getActiveTabId();
  const suiteStartUrl = await getCurrentTabUrl(tabId);
  const results: TestResult[] = [];

  for (let i = 0; i < runs.length; i++) {
    if (options.signal?.aborted) break;
    const { testCase: tc, dataRowIndex, label } = runs[i];
    log.info(`[${i + 1}/${runs.length}] Executing: "${label}"`);

    const rawResetUrl = tc.startUrl ?? suiteStartUrl;
    const resetUrl = (options.targetOrigin && rawResetUrl && tc.startUrl)
      ? rewriteUrlIfSameOrigin(rawResetUrl, tc.startUrl, options.targetOrigin)
      : rawResetUrl;
    if (resetUrl) {
      try { await navigateTab(tabId, resetUrl); } catch { /* non-fatal */ }
    }

    try {
      const result = await executeTestBounded(tc, services, tabId, { ...options, dataRowIndex });
      results.push(result);
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        log.warn(`Budget cap reached — stopping run. Remaining ${runs.length - i - 1} run(s) not executed.`);
        break;
      }
      throw err;
    }
  }

  log.info(`Run complete: ${results.filter((r) => r.status === 'passed').length}/${results.length} passed`);
  return results;
}

// ---------------------------------------------------------------------------
// Parallel runner — opens N tabs, distributes tests across a shared queue
// ---------------------------------------------------------------------------
async function runParallel(
  runs: DataRun[],
  services: ExecutionServices,
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

  log.info(`Parallel run: ${runs.length} run(s) across ${tabIds.length} tabs`);

  // Shared work queue of (index, run) so results map back to input order
  // regardless of which worker finishes first.
  const queue: Array<{ index: number; run: DataRun }> = runs.map((run, index) => ({ index, run }));
  const resultsByIndex = new Array<TestResult | undefined>(runs.length);
  let budgetStopped = false;

  const workers = tabIds.map(async (tabId) => {
    // `for (;;)` rather than `while (true)`: the loop genuinely runs until the
    // queue drains or the run is stopped, and this is the spelling the
    // no-constant-condition rule is written to accept.
    for (;;) {
      if (options.signal?.aborted || budgetStopped) break;
      const item = queue.shift();
      if (!item) break;
      const { index, run } = item;
      const { testCase: tc, dataRowIndex } = run;

      const rawResetUrl = tc.startUrl ?? suiteStartUrl;
      const resetUrl = (options.targetOrigin && rawResetUrl && tc.startUrl)
        ? rewriteUrlIfSameOrigin(rawResetUrl, tc.startUrl, options.targetOrigin)
        : rawResetUrl;
      if (resetUrl) {
        try { await navigateTab(tabId, resetUrl); } catch { /* non-fatal */ }
      }

      try {
        resultsByIndex[index] = await executeTestBounded(tc, services, tabId, {
          ...options,
          dataRowIndex,
        });
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          log.warn('Budget cap reached — stopping parallel run.');
          budgetStopped = true;
          break;
        }
        throw err;
      }
    }
  });

  try {
    await Promise.all(workers);
  } finally {
    // Always clean up the extra tabs, even if a worker threw a non-budget
    // error — otherwise a failed parallel run leaks background tabs.
    for (const tabId of extraTabIds) {
      try { await chrome.tabs.remove(tabId); } catch { /* tab may already be closed */ }
    }
  }

  const results: TestResult[] = resultsByIndex.filter((r): r is TestResult => r !== undefined);
  log.info(`Parallel run complete: ${results.filter((r) => r.status === 'passed').length}/${results.length} passed`);
  return results;
}

// ---------------------------------------------------------------------------
// Internal: run one attempt of a test
// ---------------------------------------------------------------------------
async function attemptExecution(
  testCase: TestCase,
  services: ExecutionServices,
  tabId: number,
  runId: string,
  startedAt: string,
  options: ExecutionOptions & { cdpActive?: boolean },
  freshPlan: boolean,
  timeoutMultiplier: number
): Promise<TestResult> {
  // ── Auth setup: inject cookies and verify session before test ──
  // If verification fails we still proceed (aborting every test on an
  // unverifiable session is often worse), but we RECORD the warning so a
  // downstream failure isn't misattributed — a test that fails because it was
  // never authenticated should say so, not just log it and look like a UI bug.
  let authWarning: string | undefined;
  if (testCase.requiresAuthenticatedSession && testCase.executionPresetId) {
    const authResult = await ensureAuthenticated(tabId, testCase.executionPresetId, testCase.startUrl);
    if (!authResult.authenticated) {
      authWarning = `Auth setup could not be verified (method: ${authResult.method}) — the test ran without a confirmed session and may fail for that reason.`;
      log.warn(authWarning);
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
      // Wait for the SPA to actually settle (network idle + DOM) rather than a
      // blind 2s sleep — faster on quick pages, more reliable on slow ones.
      await settleTab(tabId, options.cdpActive, 2000);

      // Scrub client state AFTER navigating: storage is origin-scoped, so a scrub
      // on about:blank silently does nothing. Concurrent tests share a profile —
      // without this, a draft or cached flag left by a sibling test shows up here
      // as a product bug.
      if ((options.isolation ?? 'reset') !== 'none') {
        const isolation = await isolateBeforeTest((expr) => evaluateInTab(tabId, expr), {
          level: options.isolation ?? 'reset',
          preserveKeys: options.preserveStorageKeys,
        });
        if (isolation.clearedLocalStorage + isolation.clearedSessionStorage > 0 || isolation.errors.length) {
          log.info(describeIsolation(isolation));
        }
      }
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
    // §6: the only place a model may shape what runs, and it is injected rather
    // than imported — the executor holds no AI dependency.
    plan = await services.plan(testCase, {
      tabId,
      forceFresh: freshPlan,
      planningMode: options.planningMode ?? 'auto',
      accessibilityContext: axContext,
    });
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

  // ── IR execution path (§6) ──────────────────────────────────────────────
  //
  // Opted into, because the legacy path still carries behaviour the IR path does
  // not (healing, retry ladder, auth recovery). Refused automatically whenever
  // conversion would drop a step: running the remainder would execute a DIFFERENT
  // test than the one authored.
  if (options.useIrPath) {
    const decision = evaluateIrPath(testCase, plan);
    log.info(explainPathChoice(decision, testCase.title));
    if (decision.usable) {
      return executeViaIr(testCase, decision.ir, tabId, {
        runId,
        signal: options.signal ? { aborted: options.signal.aborted } : undefined,
      });
    }
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

  const startFromStep = options.startFromStep ?? 0;
  // A resumed run's skipped prefix is recorded up front so the result reports
  // every step of the test, not just the tail that ran.
  const stepResults: StepResult[] = skippedPrefix(steps, startFromStep);
  let aborted = false;
  /**
   * Why the attempt failed, when the cause was an assertion this run generated
   * rather than a step the test author wrote.
   *
   * Kept separate so the failure can be named as a generated check: a user
   * reading "assertion failed" for a step they never wrote would reasonably
   * treat it as a product defect.
   */
  let generatedAssertionFailure: string | undefined;
  let previousStep: ExecutionStep | undefined;
  const capturedValues = new Map<string, string>();
  // Data columns are seeded BEFORE the walk so `{{column}}` resolves through
  // `resolveStepVariables` exactly like a captured value — one substitution
  // path, not two. A later capture step may legitimately shadow a column; the
  // dataset parser rejects the reserved loop names, so the only collisions
  // possible are deliberate ones.
  if (testCase.dataSet && options.dataRowIndex !== undefined) {
    for (const [name, value] of rowVariables(testCase.dataSet, options.dataRowIndex)) {
      capturedValues.set(name, value);
    }
  }
  const oracleFindings: NonNullable<TestResult['oracleFindings']> = [];

  for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
    const step = steps[stepIndex];
    if (aborted || options.signal?.aborted) {
      stepResults.push({ step, status: 'skipped', duration: 0 });
      continue;
    }
    // Resumed run: the prefix was already recorded as skipped before the walk.
    // `previousStep` is deliberately NOT advanced past it — the post-step settle
    // delay must be derived from a step that actually ran.
    if (step.order < startFromStep) continue;

    // Capture URL before step for assertion generator context
    const preStepUrl = options.useAIAssertions
      ? await getPageSnapshot(tabId).then((s) => s?.url ?? '').catch(() => '')
      : '';

    // Let the previous step's effects settle before the next one. Prefer the
    // network-idle/DOM-settle signal when CDP is live; the action-type ladder is
    // only the fallback ceiling when CDP is unavailable.
    await settleTab(tabId, options.cdpActive, getPostStepDelay(previousStep, step));

    const stepStart = Date.now();

    // ── State-diff oracles (§ deeper oracles) ──────────────────────────────
    //
    // Snapshot only before steps that could change something. Every step would
    // double the evaluate traffic for no gain: a `type` or an `assert` has nothing
    // for these oracles to say.
    //
    // This is what lets a test PASS and still report a defect — "the banner said
    // saved but nothing was persisted" is invisible to the test's own assertions.
    const oracleWorthy = options.stateOracles !== false && isMutatingStep(step);
    // `driverForTab` throws synchronously when no driver is registered, so the
    // guard has to be a try/catch rather than a promise `.catch`. An oracle that
    // cannot observe must be silent, never fatal.
    const stateBefore = oracleWorthy ? await tryCaptureState(tabId) : null;

    // Handle extended action types (conditional, loop, capture)
    if (step.action === 'if_visible' || step.action === 'loop' || step.action === 'capture_value' || step.action === 'use_captured') {
      const extResult = await executeExtendedStep(step, tabId, capturedValues, runStep);
      extResult.duration = Date.now() - stepStart;
      stepResults.push(extResult);
      options.onStepResult?.(testCase.id, step.order, extResult);
      previousStep = step;
      if (extResult.status === 'failed') aborted = true;
      continue;
    }

    // Resolve captured variables in step values
    const resolvedStep = resolveStepVariables(step, capturedValues);

    // A resumed run skipped the capture steps that would have produced these
    // values. Typing the literal "{{orderNo}}" into a field would "pass" while
    // exercising nothing, so fail the step and say why instead.
    const unresolved = startFromStep > 0 ? unresolvedPlaceholders(resolvedStep) : [];
    if (unresolved.length > 0) {
      stepResults.push({
        step: resolvedStep,
        status: 'failed',
        duration: 0,
        error:
          `Cannot resume from step ${startFromStep}: this step needs ` +
          `${unresolved.map((n) => `{{${n}}}`).join(', ')}, captured by a step that was skipped. ` +
          `Resume from at or before the capturing step.`,
      });
      options.onStepResult?.(testCase.id, step.order, stepResults[stepResults.length - 1]);
      aborted = true;
      continue;
    }

    // Use CDP trusted events when available, fall back to synthetic
    const executeStep = runStep;
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
        const retryAfterAuth = await runStep(resolvedStep, tabId);
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
        // Give transient conditions (mid-render, animation) a chance to clear —
        // settle on the live signal when CDP is up, else a bounded backoff.
        await settleTab(tabId, options.cdpActive, Math.min(1500, (step.timeout ?? 10000) * 0.15));
        const quickRetry = await runStep(resolvedStep, tabId);
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
      // Heal + retry using the SAME runner the test is using (CDP trusted events
      // when a CDP session is live), so validation matches real execution.
      const activeRunner = runStep;
      // Healing is a capability the caller supplies. Absent = a failed step stays
      // failed, which is a supported mode rather than a broken one (§6).
      const healed = services.heal
        ? await services.heal(step, result.error ?? '', tabId, activeRunner, {
            // Captured just above, at the exact moment of failure — the only
            // view of the page before healing starts perturbing it.
            screenshot: failScreenshot,
          })
        : null;

      if (healed && healed.success && healed.healedStep) {
        const retriedResult = await activeRunner(healed.healedStep, tabId);
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
      } else if (healed) {
        result = { ...result, healingAttempt: healed.attempt, screenshot: failScreenshot };
        aborted = true;
      } else {
        // No healer supplied — the step failure stands, with its screenshot.
        result.screenshot = failScreenshot;
        aborted = true;
      }
    } else if (result.status === 'failed') {
      // No selector to heal — capture screenshot and abort
      result.screenshot = await captureTab(tabId).catch(() => undefined);
      log.warn(`Step ${step.order} failed (no selector to heal): ${result.error}`);
      aborted = true;
    }

    result.duration = Date.now() - stepStart;
    // Carried onto the result so a failure can be attributed. Without it, a step
    // that failed on an element exploration never recorded is indistinguishable
    // from a genuine regression (T13).
    const authored = authoringConfidence(testCase, step.order);
    if (authored !== undefined) result.groundedAtAuthoring = authored;
    stepResults.push(result);
    options.onStepResult?.(testCase.id, step.order, result);
    previousStep = step;

    // Judge what the step actually did across DOM, network, storage and URL.
    if (stateBefore && result.status === 'passed') {
      try {
        const driver = driverForTab(tabId);
        const stateAfter = await captureState(driver);
        const diff = diffState(stateBefore, stateAfter, driver.networkLog());
        const findings = runStateOracles(diff, {
          action: step.description || step.action,
          // A saved test is read-only with respect to the network unless the run
          // explicitly opted in (§7), so an observed write is worth reporting.
          readOnly: options.allowMutations !== true,
          expectedToWrite: options.allowMutations === true && isSubmitStep(step),
        });
        for (const f of findings) {
          oracleFindings.push({ ...f, stepOrder: step.order });
          log.warn(`Oracle [${f.kind}] step ${step.order}: ${f.message} — ${f.evidence}`);
        }
      } catch (err) {
        // An oracle that cannot observe is silent, never fatal: it must not turn a
        // passing test into a failure because a snapshot failed.
        log.debug('State oracle evaluation failed', err);
      }
    }

    // Auto-generate assertion from live DOM after key steps (when enabled and step passed)
    if (options.useAIAssertions && result.status === 'passed') {
      const nextStep = steps[stepIndex + 1];
      const nextIsAssert = nextStep?.action === 'assert';
      if (!nextIsAssert) {
        // §6: supplied by the caller, not imported. Absent = no auto-assertions.
        //
        // Generation being unavailable or failing is a missing capability, not a
        // test failure: `null` means "no assertion was added", and nothing
        // downstream may treat that as a check that passed.
        const autoStep = services.suggestAssertion
          ? await services
              .suggestAssertion(tabId, step, preStepUrl)
              .catch(() => null)
          : null;
        if (autoStep) {
          autoStep.order = step.order + 0.5;
          const executeStep = runStep;
          // An assertion that was generated and then could not be run leaves its
          // question unanswered. Discarding it reported a clean pass for a check
          // whose outcome is unknown, so the throw becomes a failed step instead.
          const assertResult = await executeStep(autoStep, tabId).catch(
            (err): StepResult => ({
              step: autoStep,
              status: 'failed',
              duration: 0,
              error: `Generated assertion could not be run: ${
                err instanceof Error ? err.message : String(err)
              }`,
            })
          );
          assertResult.duration = assertResult.duration ?? 0;
          stepResults.push(assertResult);
          options.onStepResult?.(testCase.id, autoStep.order, assertResult);
          // The whole point of running it. Without this the attempt's status is
          // derived from `aborted` alone, so a failed assertion sat visibly
          // inside a green result — an assertion that is run and then ignored is
          // strictly worse than one that was never generated.
          if (assertResult.status === 'failed') {
            generatedAssertionFailure = assertResult.error ?? autoStep.description;
            aborted = true;
          }
        }
      }
    }
  }

  // A signal abort (per-test ceiling or user stop) mid-run is a failure, not a
  // pass-with-skipped-steps.
  const signalAborted = options.signal?.aborted ?? false;
  const finalStatus = (aborted || signalAborted) ? 'failed' : 'passed';
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
    testCaseTitle: resultTitle(testCase, options.dataRowIndex),
    status: finalStatus,
    startedAt,
    completedAt: new Date().toISOString(),
    duration: Date.now() - new Date(startedAt).getTime(),
    steps: stepResults,
    screenshot,
    domSnapshot: snapshot?.domCompressed,
    errorMessage: buildErrorMessage(
      finalStatus,
      aborted,
      signalAborted,
      stepResults,
      authWarning,
      generatedAssertionFailure,
    ),
    healingAttempts: stepResults.filter((r) => r.healingAttempt).map((r) => r.healingAttempt!),
    oracleFindings: oracleFindings.length > 0 ? oracleFindings : undefined,
    runId,
  };
}

/**
 * Snapshot page state, or null when it cannot be observed.
 *
 * Swallows BOTH a synchronous missing-driver throw and an async evaluate failure.
 * The state oracles are an additional signal layered on top of a test; a run must
 * never fail because that signal was unavailable.
 */
async function tryCaptureState(tabId: number): Promise<StateSnapshot | null> {
  try {
    return await captureState(driverForTab(tabId));
  } catch {
    return null;
  }
}

/**
 * Could this step change observable state?
 *
 * Conservative: only actions that can plausibly cause an effect are worth two
 * extra snapshots. A `type` changes a field the diff would report as noise on
 * every keystroke.
 */














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

/**
 * Wait for the tab to stabilize after a navigation or interaction. When a CDP
 * session is live (the normal case — initCDPSession enables the Network domain)
 * this waits for the network to go quiet and the DOM to settle, so fast pages
 * proceed in a few hundred ms and slow SPAs get the time they need. Falls back
 * to a fixed sleep only when CDP is unavailable for the tab.
 */
async function settleTab(tabId: number, cdpActive: boolean | undefined, fallbackMs: number): Promise<void> {
  if (cdpActive && isAttached(tabId)) {
    await waitForNetworkIdle(tabId, { idleMs: 350, timeoutMs: Math.max(3_000, fallbackMs * 2) });
    await waitForDomSettle(tabId, 2_000);
  } else {
    await delay(fallbackMs);
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
