import type { TestCase, TestResult, TestRun } from '../storage/schemas.js';
import type { AIClientInterface } from '../core/ai/ai-client.js';
import type { PlanningMode } from '../core/executor/test-executor.js';
import { expandBatch } from './batch-expander.js';
import { runTests } from './concurrent-runner.js';
import { launchBrowser, closeBrowser } from '../browser/browser-manager.js';
import { loadGraph } from '../core/explorer/interaction-graph.js';
import { detectGraphOrigin, rewriteOrigin } from '../environment/url-resolver.js';
import { generateRunId } from '../utils/hash.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('run-manager');

export interface RunOptions {
  targetUrl: string;
  headless?: boolean;
  concurrency?: number;
  batchSize?: number;
  sharedContext?: string;
  /** Path to a Playwright storageState JSON for pre-authenticated sessions */
  storageStatePath?: string;
  /**
   * Planning strategy:
   * - 'single-shot' (default): one AI call generates all steps at once
   * - 'interactive': AI walks the app live to verify each step
   * - 'auto': interactive on attempt 1, single-shot on retries
   */
  planningMode?: PlanningMode;
  /**
   * Validate generated selectors against the live page and auto-repair before execution.
   * Only applies to single-shot planning. Default false.
   */
  validatePlan?: boolean;
  /** AbortSignal to stop the run early. */
  signal?: AbortSignal;
}

export async function runOneLiners(oneLiners: string[], aiClient: AIClientInterface, options: RunOptions): Promise<TestRun> {
  const { targetUrl, headless = true, concurrency = 3, batchSize = 3, storageStatePath, planningMode, validatePlan, signal } = options;
  const runId = generateRunId();
  const startedAt = new Date().toISOString();

  log.info(`Starting run: ${oneLiners.length} one-liners against ${targetUrl}`);

  // 1. Detect environment mismatch — if graph was explored on a different origin,
  //    we need to rewrite all URLs in expanded tests to the target origin.
  const graph = await loadGraph();
  const graphOrigin = graph ? detectGraphOrigin(graph.nodes.map((n) => n.url)) : undefined;
  let targetOrigin: string | undefined;
  try { targetOrigin = new URL(targetUrl).origin; } catch { /* ignore invalid */ }

  const needsRewrite = graphOrigin && targetOrigin && graphOrigin !== targetOrigin;
  if (needsRewrite) {
    log.info(`Environment mismatch: graph origin=${graphOrigin}, target=${targetOrigin}. URLs will be rewritten.`);
  }

  // 2. Expand one-liners into test cases
  const testCases = await expandBatch(oneLiners, aiClient, batchSize, targetUrl);
  const validTests = testCases.filter((tc) => tc.status !== 'error');

  // 3. Rewrite URLs if running against a different environment
  if (needsRewrite && graphOrigin && targetOrigin) {
    for (const tc of validTests) {
      if (tc.startUrl) {
        tc.startUrl = rewriteOrigin(tc.startUrl, targetOrigin);
      }
      if (tc.steps) {
        tc.steps = tc.steps.map((step) =>
          step.replace(new RegExp(graphOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), targetOrigin)
        );
      }
    }
    log.info(`Rewrote URLs in ${validTests.length} test cases from ${graphOrigin} to ${targetOrigin}`);
  }

  // 4. Launch browser (ensures global browser process is ready for isolated contexts)
  await launchBrowser(headless);

  // 5. Execute tests — each test runs in its own isolated BrowserContext
  let results: TestResult[];
  try {
    results = await runTests(validTests, aiClient, concurrency, { runId, headless, storageStatePath, planningMode, validatePlan, signal });
  } finally {
    await closeBrowser();
  }

  // 6. Build run summary
  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const errored = results.filter((r) => r.status === 'error').length;

  const run: TestRun = {
    id: runId, startedAt, completedAt: new Date().toISOString(),
    testCaseIds: testCases.map((tc) => tc.id), results,
    summary: {
      total: results.length, passed, failed, error: errored,
      avgDuration: results.length > 0 ? results.reduce((s, r) => s + (r.duration ?? 0), 0) / results.length : 0,
      healedCount: results.filter((r) => r.healingAttempts.length > 0).length,
    },
  };

  log.info(`Run ${runId} complete: ${passed}/${results.length} passed`);
  return run;
}
