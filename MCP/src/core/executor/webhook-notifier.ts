import type { TestResult, WebhookConfig } from '../../storage/schemas.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('webhook');

export async function notifySuiteComplete(results: TestResult[], runId: string, config?: WebhookConfig): Promise<void> {
  if (!config?.enabled || (config.trigger !== 'suite_complete' && config.trigger !== 'both')) return;
  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const errored = results.filter((r) => r.status === 'error').length;
  const payload = {
    event: 'suite_complete', timestamp: new Date().toISOString(), source: 'pathfinder',
    data: {
      runId, total: results.length, passed, failed, error: errored,
      duration: results.reduce((s, r) => s + (r.duration ?? 0), 0),
      passRate: results.length > 0 ? Math.round((passed / results.length) * 100) : 0,
      results: results.map((r) => ({
        testCaseId: r.testCaseId, testCaseTitle: r.testCaseTitle, status: r.status,
        duration: r.duration ?? 0, errorMessage: r.errorMessage,
        healingAttempts: r.healingAttempts.length,
        stepsPassed: r.steps.filter((s) => s.status === 'passed').length,
        stepsFailed: r.steps.filter((s) => s.status === 'failed').length,
        stepsTotal: r.steps.length,
      })),
    },
  };
  try {
    const res = await fetch(config.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...config.headers }, body: JSON.stringify(payload) });
    if (!res.ok) log.warn(`Webhook returned ${res.status}`);
    else log.info('Webhook sent: suite_complete');
  } catch (err) { log.warn('Webhook failed', err); }
}
