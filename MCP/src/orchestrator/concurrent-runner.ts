import type { TestCase, TestResult } from '../storage/schemas.js';
import type { AIClientInterface } from '../core/ai/ai-client.js';
import { executeTest, type ExecutionOptions } from '../core/executor/test-executor.js';
import { newIsolatedContext, injectCaptureObserver } from '../browser/browser-manager.js';
import { generateRunId } from '../utils/hash.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('runner');

export async function runTests(tests: TestCase[], aiClient: AIClientInterface, concurrency: number = 3, options: ExecutionOptions = {}): Promise<TestResult[]> {
  const runId = options.runId ?? generateRunId();
  const { headless = true, storageStatePath } = options;
  const queue = [...tests];
  const results: TestResult[] = [];
  const effectiveConcurrency = Math.max(1, Math.min(4, concurrency));

  log.info(`Running ${tests.length} tests with concurrency=${effectiveConcurrency}`);

  const workers = Array.from({ length: effectiveConcurrency }, () =>
    (async () => {
      while (queue.length > 0) {
        if (options.signal?.aborted) break;
        const test = queue.shift()!;
        // Each test gets its own isolated context — fresh cookies + localStorage,
        // no state leakage between concurrent tests
        const ctx = await newIsolatedContext(headless, storageStatePath);
        const page = await ctx.newPage();
        await injectCaptureObserver(page);
        try {
          const result = await executeTest(page, test, aiClient, { ...options, runId });
          results.push(result);
        } catch (err) {
          log.error(`Test "${test.title}" threw`, err);
        } finally {
          await ctx.close().catch(() => {});
        }
      }
    })()
  );

  await Promise.all(workers);
  log.info(`Run complete: ${results.filter((r) => r.status === 'passed').length}/${results.length} passed`);
  return results;
}
