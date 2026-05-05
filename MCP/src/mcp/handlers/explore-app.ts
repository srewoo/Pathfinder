import type { AppConfig } from '../../config/config.js';
import { launchBrowser, newPage, closeBrowser } from '../../browser/browser-manager.js';
import { exploreApp } from '../../core/explorer/explorer-agent.js';
import { serializeGraphForAI } from '../../core/explorer/interaction-graph.js';
import { createAIClient } from '../../core/ai/ai-client.js';
import { startOperation, finishOperation } from '../../orchestrator/operation-abort.js';
import { withErrorHandling } from './_error-wrapper.js';

export async function handleExploreApp(
  args: {
    url: string;
    depth?: number;
    max_pages?: number;
    headless?: boolean;
    storage_state_path?: string;
    agent_mode?: boolean;
  },
  config: AppConfig
) {
  return withErrorHandling(async () => {
    const signal = startOperation('explore');

    await launchBrowser(args.headless ?? config.browser.headless, args.storage_state_path);
    const page = await newPage();
    try {
      const aiClient = args.agent_mode
        ? createAIClient({
            provider: config.ai.provider,
            apiKey: config.ai.apiKey,
            model: config.ai.model,
            embeddingModel: config.ai.embeddingModel,
            useLocalEmbeddings: config.ai.useLocalEmbeddings,
          })
        : undefined;

      const graph = await exploreApp(page, {
        startUrl: args.url,
        maxDepth: args.depth ?? 3,
        maxPages: args.max_pages ?? 100,
        agentMode: args.agent_mode ?? false,
        aiClient,
        signal,
      });

      const modeLabel = args.agent_mode ? ' (AI-guided)' : '';
      const stoppedNote = signal.aborted ? ' (stopped early)' : '';
      const summary = serializeGraphForAI(graph);
      return {
        content: [{
          type: 'text' as const,
          text: `Explored${modeLabel}${stoppedNote} ${graph.nodes.length} pages, ${graph.edges.length} edges.\n\n${summary}`,
        }],
      };
    } finally {
      finishOperation('explore');
      await page.close().catch(() => {});
      await closeBrowser();
    }
  }, 'explore_app');
}
