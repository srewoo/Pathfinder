import { createLogger } from '../../utils/logger';
import { resolveModelPrice } from './model-pricing';

const log = createLogger('token-tracker');

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  embeddingTokens: number;
  requests: number;
}

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
  /**
   * The published price entry the chat figures were computed from, when it is
   * not the model id itself — a dated snapshot or a variant priced off its
   * family. Undefined when the id was priced exactly.
   */
  pricedAs?: string;
  /** A caveat on the published rate (promotional period, context tier). */
  priceNote?: string;
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
  const chat = resolveModelPrice(m);
  const embed = resolveModelPrice(currentEmbeddingModel);

  const chatUsd = chat
    ? (currentUsage.inputTokens / 1_000_000) * chat.price.input +
      (currentUsage.outputTokens / 1_000_000) * chat.price.output
    : 0;
  const embeddingUsd = embed ? (currentUsage.embeddingTokens / 1_000_000) * embed.price.input : 0;
  const round = (n: number): number => Math.round(n * 10000) / 10000;

  return {
    chatUsd: round(chatUsd),
    embeddingUsd: round(embeddingUsd),
    totalUsd: round(chatUsd + embeddingUsd),
    model: m,
    embeddingModel: currentEmbeddingModel,
    pricingUnknown: (currentUsage.inputTokens > 0 || currentUsage.outputTokens > 0) && !chat,
    pricedAs: chat && !chat.exact ? chat.pricedAs : undefined,
    priceNote: chat?.price.note,
    usage: { ...currentUsage },
  };
}
