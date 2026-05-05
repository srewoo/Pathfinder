import { createLogger } from '../../utils/logger.js';

const log = createLogger('token-tracker');

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  embeddingTokens: number;
  requests: number;
}

// Per-model cost per 1M tokens (USD). Update as pricing changes.
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  // OpenAI
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4-turbo': { input: 10, output: 30 },
  'o1': { input: 15, output: 60 },
  'o3-mini': { input: 1.1, output: 4.4 },
  // Anthropic
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4 },
  'claude-opus-4-20250514': { input: 15, output: 75 },
  // Google
  'gemini-1.5-pro': { input: 1.25, output: 5 },
  'gemini-1.5-flash': { input: 0.075, output: 0.3 },
  // Embedding
  'text-embedding-3-small': { input: 0.02, output: 0 },
  'text-embedding-004': { input: 0.006, output: 0 },
};

let currentUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, embeddingTokens: 0, requests: 0 };
let currentModel = '';

export function recordChatUsage(model: string, inputTokens: number, outputTokens: number): void {
  currentUsage.inputTokens += inputTokens;
  currentUsage.outputTokens += outputTokens;
  currentUsage.requests++;
  currentModel = model;
  log.debug(`Chat tokens: +${inputTokens} in / +${outputTokens} out (total: ${currentUsage.inputTokens}/${currentUsage.outputTokens})`);
}

export function recordEmbeddingUsage(tokenCount: number): void {
  currentUsage.embeddingTokens += tokenCount;
}

export function getTokenUsage(): TokenUsage {
  return { ...currentUsage };
}

export function resetTokenUsage(): void {
  currentUsage = { inputTokens: 0, outputTokens: 0, embeddingTokens: 0, requests: 0 };
}

export function estimateCost(model?: string): number {
  const m = model ?? currentModel;
  const costs = MODEL_COSTS[m];
  if (!costs) return 0;

  const inputCost = (currentUsage.inputTokens / 1_000_000) * costs.input;
  const outputCost = (currentUsage.outputTokens / 1_000_000) * costs.output;
  return Math.round((inputCost + outputCost) * 10000) / 10000;
}

export function formatTokenSummary(model?: string): string {
  const usage = getTokenUsage();
  const cost = estimateCost(model);
  const parts = [
    `Tokens: ${usage.inputTokens.toLocaleString()} in + ${usage.outputTokens.toLocaleString()} out`,
  ];
  if (usage.embeddingTokens > 0) {
    parts.push(`${usage.embeddingTokens.toLocaleString()} embed`);
  }
  parts.push(`${usage.requests} requests`);
  if (cost > 0) {
    parts.push(`Est. cost: $${cost.toFixed(4)}`);
  }
  return parts.join(' | ');
}
