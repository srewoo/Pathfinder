import type { AppConfig } from '../../config/config.js';
import { createAIClient } from '../../core/ai/ai-client.js';
import { runOneLiners } from '../../orchestrator/run-manager.js';
import { generateHtmlReport } from '../../reporting/html-reporter.js';
import { resetTokenUsage, formatTokenSummary } from '../../core/ai/token-tracker.js';
import { startOperation, finishOperation } from '../../orchestrator/operation-abort.js';
import { withErrorHandling } from './_error-wrapper.js';

export async function handleRunOneLiners(args: {
  test_cases: string[];
  target_url: string;
  batch_size?: number;
  headless?: boolean;
  concurrency?: number;
  shared_context?: string;
  storage_state_path?: string;
  planning_mode?: 'single-shot' | 'interactive' | 'auto';
  validate_plan?: boolean;
}, config: AppConfig) {
  return withErrorHandling(async () => {
    resetTokenUsage();

    const signal = startOperation('run');

    const aiClient = createAIClient({
      provider: config.ai.provider,
      apiKey: config.ai.apiKey,
      model: config.ai.model,
      embeddingModel: config.ai.embeddingModel,
      useLocalEmbeddings: config.ai.useLocalEmbeddings,
    });

    try {
      const run = await runOneLiners(args.test_cases, aiClient, {
        targetUrl: args.target_url,
        headless: args.headless ?? config.browser.headless,
        concurrency: args.concurrency ?? config.browser.concurrency,
        batchSize: args.batch_size ?? config.execution.batchSize,
        sharedContext: args.shared_context,
        storageStatePath: args.storage_state_path,
        planningMode: args.planning_mode ?? 'single-shot',
        validatePlan: args.validate_plan ?? false,
        signal,
      });

      const htmlReport = generateHtmlReport(run.results);
      const tokenInfo = formatTokenSummary(config.ai.model);
      const stoppedNote = signal.aborted ? ' (stopped early)' : '';
      const summary = `Run ${run.id}: ${run.summary.passed}/${run.summary.total} passed, ${run.summary.failed} failed, ${run.summary.error} errors${stoppedNote} | ${tokenInfo}`;

      return {
        content: [
          { type: 'text' as const, text: summary },
          { type: 'text' as const, text: `\n\nHTML Report (${htmlReport.length} chars):\n${htmlReport}` },
        ],
      };
    } finally {
      finishOperation('run');
    }
  }, 'run_one_liners');
}
