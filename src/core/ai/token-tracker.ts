import { createLogger } from '../../utils/logger';

const log = createLogger('token-tracker');

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  embeddingTokens: number;
  requests: number;
}

// Per-model cost per 1M tokens (USD). Update as pricing changes.
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  // OpenAI — GPT-5 series (reasoning / thinking models)
  'gpt-5': { input: 1.25, output: 10 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  'gpt-5-nano': { input: 0.05, output: 0.4 },
  // OpenAI — legacy
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4-turbo': { input: 10, output: 30 },
  'o1': { input: 15, output: 60 },
  'o3-mini': { input: 1.1, output: 4.4 },
  // Anthropic — Claude 4.x
  'claude-opus-4-7': { input: 15, output: 75 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4 },
  // Anthropic — legacy IDs (kept for back-compat with existing settings)
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-opus-4-20250514': { input: 15, output: 75 },
  // Google
  'gemini-3-pro': { input: 2, output: 10 },
  'gemini-3-flash': { input: 0.15, output: 0.6 },
  'gemini-1.5-pro': { input: 1.25, output: 5 },
  'gemini-1.5-flash': { input: 0.075, output: 0.3 },
  // Embedding
  'text-embedding-3-small': { input: 0.02, output: 0 },
  'text-embedding-004': { input: 0.006, output: 0 },
};

let currentUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, embeddingTokens: 0, requests: 0 };
let currentModel = '';
let currentEmbeddingModel = '';
/** Called whenever usage changes, so a host can persist it. */
let onChange: ((usage: TokenUsage) => void) | null = null;

/**
 * Register a persistence hook.
 *
 * The counters live in the service worker, which Chrome evicts after ~30s idle —
 * so without this the reported cost silently resets to zero mid-session and the
 * budget guard forgets everything already spent.
 */
export function onUsageChange(fn: (usage: TokenUsage) => void): void {
  onChange = fn;
}

/** Restore counters after a worker restart. */
export function restoreTokenUsage(usage: Partial<TokenUsage>, model?: string): void {
  currentUsage = {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    embeddingTokens: usage.embeddingTokens ?? 0,
    requests: usage.requests ?? 0,
  };
  if (model) currentModel = model;
}

export function recordChatUsage(model: string, inputTokens: number, outputTokens: number): void {
  currentUsage.inputTokens += inputTokens;
  currentUsage.outputTokens += outputTokens;
  currentUsage.requests++;
  currentModel = model;
  log.debug(`Chat tokens: +${inputTokens} in / +${outputTokens} out (total: ${currentUsage.inputTokens}/${currentUsage.outputTokens})`);
  onChange?.({ ...currentUsage });
}

/**
 * Record embedding tokens.
 *
 * Separate from chat because embeddings are priced per input token only, and
 * because a local model costs nothing — attributing local embeddings to an API
 * price would inflate the reported spend.
 */
export function recordEmbeddingUsage(model: string, tokenCount: number): void {
  currentUsage.embeddingTokens += tokenCount;
  currentUsage.requests++;
  currentEmbeddingModel = model;
  onChange?.({ ...currentUsage });
}

export function getTokenUsage(): TokenUsage {
  return { ...currentUsage };
}

export function resetTokenUsage(): void {
  currentUsage = { inputTokens: 0, outputTokens: 0, embeddingTokens: 0, requests: 0 };
  onChange?.({ ...currentUsage });
}

export function estimateCost(model?: string): number {
  return costBreakdown(model).totalUsd;
}

export interface CostBreakdown {
  chatUsd: number;
  embeddingUsd: number;
  totalUsd: number;
  /** The chat model the figures are priced against. */
  model: string;
  /** The embedding model, when any embeddings were recorded. */
  embeddingModel: string;
  /** True when we have no published price for the model in use. */
  pricingUnknown: boolean;
  usage: TokenUsage;
}

/**
 * Cost split by what incurred it.
 *
 * Embeddings were previously ignored by the cost math entirely, so a crawl that
 * embedded thousands of chunks reported $0. They are priced on input tokens only.
 *
 * `pricingUnknown` is reported rather than silently returning 0: "we have no price
 * for this model" and "this run was free" are different statements, and conflating
 * them turns an unknown into a reassuring number.
 */
export function costBreakdown(model?: string): CostBreakdown {
  const m = model ?? currentModel;
  const chat = MODEL_COSTS[m];
  const embed = MODEL_COSTS[currentEmbeddingModel];

  const chatUsd = chat
    ? (currentUsage.inputTokens / 1_000_000) * chat.input +
      (currentUsage.outputTokens / 1_000_000) * chat.output
    : 0;
  const embeddingUsd = embed ? (currentUsage.embeddingTokens / 1_000_000) * embed.input : 0;
  const round = (n: number): number => Math.round(n * 10000) / 10000;

  return {
    chatUsd: round(chatUsd),
    embeddingUsd: round(embeddingUsd),
    totalUsd: round(chatUsd + embeddingUsd),
    model: m,
    embeddingModel: currentEmbeddingModel,
    pricingUnknown: (currentUsage.inputTokens > 0 || currentUsage.outputTokens > 0) && !chat,
    usage: { ...currentUsage },
  };
}
