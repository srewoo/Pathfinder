import type { AppConfig } from '../../config/config.js';
import { createAIClient } from '../../core/ai/ai-client.js';
import { expandBatch } from '../../orchestrator/batch-expander.js';
import { withErrorHandling } from './_error-wrapper.js';

export async function handleExpandTests(args: { test_cases: string[]; target_url?: string; batch_size?: number }, config: AppConfig) {
  return withErrorHandling(async () => {
    const aiClient = createAIClient({
      provider: config.ai.provider, apiKey: config.ai.apiKey,
      model: config.ai.model, embeddingModel: config.ai.embeddingModel,
      useLocalEmbeddings: config.ai.useLocalEmbeddings,
    });
    const expanded = await expandBatch(args.test_cases, aiClient, args.batch_size ?? 3, args.target_url);
    const summary = expanded.map((tc) => `## ${tc.title}\nType: ${tc.type}\n${tc.steps?.map((s, i) => `${i + 1}. ${s}`).join('\n') ?? 'No steps'}`).join('\n\n');
    return { content: [{ type: 'text' as const, text: `Expanded ${expanded.length} test cases:\n\n${summary}` }] };
  }, 'expand_tests');
}
