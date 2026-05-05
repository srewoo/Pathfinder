import type { AppConfig } from '../../config/config.js';
import { createAIClient } from '../../core/ai/ai-client.js';
import { crawlSite } from '../../core/knowledge/crawler.js';
import { resetTokenUsage, formatTokenSummary } from '../../core/ai/token-tracker.js';
import { startOperation, finishOperation } from '../../orchestrator/operation-abort.js';
import { withErrorHandling } from './_error-wrapper.js';

export async function handleCrawlKnowledge(args: { url: string; depth?: number; max_pages?: number }, config: AppConfig) {
  return withErrorHandling(async () => {
    resetTokenUsage();

    const signal = startOperation('crawl');

    const aiClient = createAIClient({
      provider: config.ai.provider, apiKey: config.ai.apiKey,
      model: config.ai.model, embeddingModel: config.ai.embeddingModel,
      useLocalEmbeddings: config.ai.useLocalEmbeddings,
    });

    try {
      const result = await crawlSite(args.url, aiClient, {
        maxDepth: args.depth ?? 3,
        maxPages: args.max_pages ?? 50,
        skipEmbedRateLimit: config.ai.useLocalEmbeddings,
        signal,
      });

      const tokenInfo = formatTokenSummary(config.ai.model);
      const stoppedNote = signal.aborted ? ' (stopped early)' : '';
      return {
        content: [{ type: 'text' as const, text: `Crawled ${result.docCount} pages, ${result.vectorCount} vectors. Skipped: ${result.skippedCount}. Errors: ${result.errors.length}${stoppedNote} | ${tokenInfo}` }],
      };
    } finally {
      finishOperation('crawl');
    }
  }, 'crawl_knowledge');
}
