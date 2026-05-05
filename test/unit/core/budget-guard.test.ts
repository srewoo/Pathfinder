import { describe, it, expect, beforeEach } from 'vitest';
import {
  configureBudget,
  resetBudget,
  assertWithinBudget,
  getBudgetState,
  BudgetExceededError,
} from '../../../src/core/ai/budget-guard';
import { resetTokenUsage, recordChatUsage } from '../../../src/core/ai/token-tracker';

beforeEach(() => {
  resetTokenUsage();
  resetBudget();
  configureBudget({ limitUsd: null });
});

describe('budget-guard', () => {
  it('given no limit configured when asserting then never throws', () => {
    recordChatUsage('gpt-4o', 1_000_000, 1_000_000);
    expect(() => assertWithinBudget('gpt-4o')).not.toThrow();
  });

  it('given spending under limit when asserting then no throw', () => {
    configureBudget({ limitUsd: 1 });
    recordChatUsage('gpt-4o', 1000, 100); // tiny — well under $1
    expect(() => assertWithinBudget('gpt-4o')).not.toThrow();
  });

  it('given spending exceeds limit when asserting then throws BudgetExceededError', () => {
    configureBudget({ limitUsd: 0.001 });
    // gpt-4o: $2.5/M in + $10/M out — 1k in + 1k out = $0.0025 + $0.01 ≈ $0.0125
    recordChatUsage('gpt-4o', 1000, 1000);
    expect(() => assertWithinBudget('gpt-4o')).toThrow(BudgetExceededError);
  });

  it('given onExceeded callback when limit hit then fires once', () => {
    let calls = 0;
    configureBudget({ limitUsd: 0.001, onExceeded: () => { calls++; } });
    recordChatUsage('gpt-4o', 1000, 1000);
    try { assertWithinBudget('gpt-4o'); } catch { /* expected */ }
    try { assertWithinBudget('gpt-4o'); } catch { /* expected */ }
    expect(calls).toBe(1);
  });

  it('given exceeded then resetBudget when asserting again then throws fresh', () => {
    configureBudget({ limitUsd: 0.001 });
    recordChatUsage('gpt-4o', 1000, 1000);
    expect(() => assertWithinBudget('gpt-4o')).toThrow();
    resetBudget();
    expect(() => assertWithinBudget('gpt-4o')).toThrow(); // still over budget
    const state = getBudgetState('gpt-4o');
    expect(state.exceeded).toBe(true);
  });

  it('given getBudgetState when read then returns spent and limit', () => {
    configureBudget({ limitUsd: 5 });
    recordChatUsage('gpt-4o', 1000, 1000);
    const state = getBudgetState('gpt-4o');
    expect(state.limitUsd).toBe(5);
    expect(state.spentUsd).toBeGreaterThan(0);
    expect(state.exceeded).toBe(false);
  });
});
