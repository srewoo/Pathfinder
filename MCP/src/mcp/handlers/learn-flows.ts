import type { AppConfig } from '../../config/config.js';
import { createAIClient } from '../../core/ai/ai-client.js';
import { learnFlows } from '../../core/flow/flow-learner.js';
import { withErrorHandling } from './_error-wrapper.js';

export async function handleLearnFlows(config: AppConfig) {
  return withErrorHandling(async () => {
    const aiClient = createAIClient({
      provider: config.ai.provider, apiKey: config.ai.apiKey,
      model: config.ai.model, embeddingModel: config.ai.embeddingModel,
      useLocalEmbeddings: config.ai.useLocalEmbeddings,
    });
    const flows = await learnFlows(aiClient);
    return {
      content: [{ type: 'text' as const, text: `Learned ${flows.length} flows:\n${flows.map((f) => `- ${f.name}: ${f.description}`).join('\n')}` }],
    };
  }, 'learn_flows');
}
