import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordChatUsage,
  recordEmbeddingUsage,
  getTokenUsage,
  resetTokenUsage,
  estimateCost,
  formatTokenSummary,
} from '../../src/core/ai/token-tracker.js';

describe('token-tracker', () => {
  beforeEach(() => {
    resetTokenUsage();
  });

  it('given_no_usage_when_queried_then_returns_zeros', () => {
    const usage = getTokenUsage();
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
    expect(usage.embeddingTokens).toBe(0);
    expect(usage.requests).toBe(0);
  });

  it('given_chat_usage_when_recorded_then_accumulates', () => {
    recordChatUsage('gpt-4o', 100, 50);
    recordChatUsage('gpt-4o', 200, 75);
    const usage = getTokenUsage();
    expect(usage.inputTokens).toBe(300);
    expect(usage.outputTokens).toBe(125);
    expect(usage.requests).toBe(2);
  });

  it('given_embedding_usage_when_recorded_then_accumulates', () => {
    recordEmbeddingUsage(500);
    recordEmbeddingUsage(300);
    expect(getTokenUsage().embeddingTokens).toBe(800);
  });

  it('given_reset_when_called_then_clears_all', () => {
    recordChatUsage('gpt-4o', 100, 50);
    recordEmbeddingUsage(500);
    resetTokenUsage();
    const usage = getTokenUsage();
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
    expect(usage.embeddingTokens).toBe(0);
    expect(usage.requests).toBe(0);
  });

  it('given_known_model_when_cost_estimated_then_returns_positive_value', () => {
    recordChatUsage('gpt-4o', 1_000_000, 500_000);
    const cost = estimateCost('gpt-4o');
    // gpt-4o: $2.5/1M input + $10/1M output = 2.5 + 5.0 = 7.5
    expect(cost).toBe(7.5);
  });

  it('given_unknown_model_when_cost_estimated_then_returns_zero', () => {
    recordChatUsage('unknown-model', 100, 50);
    const cost = estimateCost('unknown-model');
    expect(cost).toBe(0);
  });

  it('given_usage_when_formatted_then_includes_token_counts', () => {
    recordChatUsage('gpt-4o', 1000, 500);
    const summary = formatTokenSummary('gpt-4o');
    expect(summary).toContain('1,000 in');
    expect(summary).toContain('500 out');
    expect(summary).toContain('1 requests');
    expect(summary).toContain('Est. cost:');
  });

  it('given_embedding_usage_when_formatted_then_includes_embed_count', () => {
    recordEmbeddingUsage(2000);
    const summary = formatTokenSummary();
    expect(summary).toContain('2,000 embed');
  });
});
