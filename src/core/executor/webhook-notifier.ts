/**
 * Webhook Notifier — sends test results to external CI/CD systems.
 *
 * Supports sending notifications on:
 * - Individual test completion
 * - Full suite completion
 */
import type { TestResult, WebhookConfig } from '../../storage/schemas';
import { settingsStorage } from '../../storage/chrome-storage';
import { createLogger } from '../../utils/logger';

const log = createLogger('webhook');

interface WebhookPayload {
  event: 'test_complete' | 'suite_complete';
  timestamp: string;
  source: 'pathfinder';
  data: TestResultPayload | SuiteResultPayload;
}

interface TestResultPayload {
  testCaseId: string;
  testCaseTitle: string;
  status: string;
  duration: number;
  errorMessage?: string;
  healingAttempts: number;
  stepsPassed: number;
  stepsFailed: number;
  stepsTotal: number;
}

interface SuiteResultPayload {
  runId: string;
  total: number;
  passed: number;
  failed: number;
  error: number;
  duration: number;
  passRate: number;
  healedCount: number;
  results: TestResultPayload[];
}

/**
 * Notify webhook of a single test completion.
 */
export async function notifyTestComplete(result: TestResult): Promise<void> {
  const config = await getWebhookConfig();
  if (!config || !config.enabled) return;
  if (config.trigger !== 'test_complete' && config.trigger !== 'both') return;

  const payload: WebhookPayload = {
    event: 'test_complete',
    timestamp: new Date().toISOString(),
    source: 'pathfinder',
    data: buildTestPayload(result),
  };

  await sendWebhook(config, payload);
}

/**
 * Notify webhook of an entire suite completion.
 */
export async function notifySuiteComplete(results: TestResult[], runId: string): Promise<void> {
  const config = await getWebhookConfig();
  if (!config || !config.enabled) return;
  if (config.trigger !== 'suite_complete' && config.trigger !== 'both') return;

  const totalDuration = results.reduce((sum, r) => sum + (r.duration ?? 0), 0);
  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const errored = results.filter((r) => r.status === 'error').length;
  const healedCount = results.filter((r) => r.healingAttempts.length > 0).length;

  const payload: WebhookPayload = {
    event: 'suite_complete',
    timestamp: new Date().toISOString(),
    source: 'pathfinder',
    data: {
      runId,
      total: results.length,
      passed,
      failed,
      error: errored,
      duration: totalDuration,
      passRate: results.length > 0 ? Math.round((passed / results.length) * 100) : 0,
      healedCount,
      results: results.map(buildTestPayload),
    },
  };

  await sendWebhook(config, payload);
}

/**
 * Test a webhook URL by sending a test payload.
 */
export async function testWebhook(url: string, headers?: Record<string, string>): Promise<{ success: boolean; status?: number; error?: string }> {
  const payload: WebhookPayload = {
    event: 'test_complete',
    timestamp: new Date().toISOString(),
    source: 'pathfinder',
    data: {
      testCaseId: 'test-webhook-ping',
      testCaseTitle: 'pathfinder Webhook Test',
      status: 'passed',
      duration: 0,
      healingAttempts: 0,
      stepsPassed: 1,
      stepsFailed: 0,
      stepsTotal: 1,
    },
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(payload),
    });
    return { success: response.ok, status: response.status };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildTestPayload(result: TestResult): TestResultPayload {
  return {
    testCaseId: result.testCaseId,
    testCaseTitle: result.testCaseTitle,
    status: result.status,
    duration: result.duration ?? 0,
    errorMessage: result.errorMessage,
    healingAttempts: result.healingAttempts.length,
    stepsPassed: result.steps.filter((s) => s.status === 'passed').length,
    stepsFailed: result.steps.filter((s) => s.status === 'failed').length,
    stepsTotal: result.steps.length,
  };
}

async function getWebhookConfig(): Promise<WebhookConfig | undefined> {
  const settings = await settingsStorage.get();
  return settings.webhook;
}

async function sendWebhook(config: WebhookConfig, payload: WebhookPayload): Promise<void> {
  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...config.headers,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      log.warn(`Webhook returned ${response.status}: ${response.statusText}`);
    } else {
      log.info(`Webhook sent: ${payload.event}`);
    }
  } catch (err) {
    log.warn('Webhook delivery failed', err);
  }
}
