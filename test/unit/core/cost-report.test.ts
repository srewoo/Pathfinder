/**
 * Session cost reporting.
 *
 * The tracker this reads from had NO callers: `recordChatUsage` was never invoked,
 * so `estimateCost()` always returned 0 — and the cost budget guard, which compares
 * spend against a limit, could never fire however low the limit was set. These tests
 * pin the accounting now that providers feed it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  costBreakdown,
  recordChatUsage,
  recordEmbeddingUsage,
  resetTokenUsage,
} from '../../../src/core/ai/token-tracker';
import { formatCostReport } from '../../../src/core/ai/cost-report';

beforeEach(() => {
  resetTokenUsage();
});

describe('cost accounting', () => {
  it('given_recorded_chat_usage_then_cost_is_no_longer_zero', () => {
    // The regression in one line: this used to be 0 for every run.
    recordChatUsage('gpt-4o-mini', 1_000_000, 1_000_000);
    const b = costBreakdown();
    expect(b.chatUsd).toBeCloseTo(0.15 + 0.6, 4);
    expect(b.totalUsd).toBeGreaterThan(0);
    expect(b.usage.requests).toBe(1);
  });

  it('given_embedding_usage_then_it_is_priced_on_INPUT_tokens', () => {
    // Embeddings were ignored by the cost math entirely, so a crawl that embedded
    // thousands of chunks reported $0.
    recordEmbeddingUsage('text-embedding-3-small', 2_000_000);
    const b = costBreakdown('gpt-4o-mini');
    expect(b.embeddingUsd).toBeCloseTo(0.04, 4);
    expect(b.chatUsd).toBe(0);
    expect(b.totalUsd).toBeCloseTo(0.04, 4);
  });

  it('given_chat_and_embeddings_then_the_total_is_their_sum', () => {
    recordChatUsage('gpt-5-nano', 1_000_000, 1_000_000);
    recordEmbeddingUsage('text-embedding-3-small', 1_000_000);
    const b = costBreakdown();
    expect(b.totalUsd).toBeCloseTo(0.05 + 0.4 + 0.02, 4);
  });

  it('given_an_unknown_model_then_the_gap_is_declared_not_reported_as_free', () => {
    // "We have no price for this" and "this was free" are different claims.
    recordChatUsage('some-new-model-2027', 500_000, 500_000);
    const b = costBreakdown();
    expect(b.pricingUnknown).toBe(true);
    expect(b.usage.inputTokens).toBe(500_000);
    expect(formatCostReport({}, 'some-new-model-2027')).toContain('by absence of data');
  });

  it('given_a_reset_then_counters_return_to_zero', () => {
    recordChatUsage('gpt-4o', 1000, 1000);
    resetTokenUsage();
    expect(costBreakdown().usage.requests).toBe(0);
    expect(costBreakdown().totalUsd).toBe(0);
  });
});

describe('the report', () => {
  it('given_no_requests_then_it_says_so_rather_than_showing_a_confident_zero', () => {
    const md = formatCostReport();
    expect(md).toContain('No AI requests recorded yet');
    expect(md).not.toContain('Breakdown');
  });

  it('given_usage_then_the_total_and_a_breakdown_appear', () => {
    recordChatUsage('gpt-4o-mini', 300_000, 100_000);
    recordEmbeddingUsage('text-embedding-3-small', 50_000);
    const md = formatCostReport({ startedAt: new Date(0).toISOString() }, 'gpt-4o-mini');
    expect(md).toContain('Estimated total');
    expect(md).toContain('Chat subtotal');
    expect(md).toContain('Embeddings');
    expect(md).toContain('300,000');
  });

  it('given_a_budget_limit_then_usage_against_it_is_shown', () => {
    recordChatUsage('gpt-4o', 1_000_000, 0); // $2.50
    const md = formatCostReport({ limitUsd: 5 }, 'gpt-4o');
    expect(md).toContain('Budget');
    expect(md).toContain('of $5.00 used (50%)');
  });

  it('given_only_local_embeddings_then_it_states_they_are_free', () => {
    // Attributing local embeddings to an API price would inflate the figure.
    recordChatUsage('gpt-4o-mini', 1000, 1000);
    const md = formatCostReport({}, 'gpt-4o-mini');
    expect(md).toContain('Local embeddings are free');
  });

  it('given_a_report_then_it_states_how_the_numbers_were_derived', () => {
    // An estimate that reads like a bill is worse than one that declares itself.
    recordChatUsage('gpt-4o-mini', 1000, 1000);
    const md = formatCostReport({}, 'gpt-4o-mini');
    expect(md).toContain('How this is calculated');
    expect(md).toContain("provider's own `usage` field");
    expect(md).toContain('updated by hand');
  });
});
