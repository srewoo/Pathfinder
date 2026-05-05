/**
 * Per-session budget guard.
 *
 * Tests can run away with cost when self-healing or interactive planning
 * loops; this throws once a configured spend cap is hit. Read-only by
 * default — must be explicitly enabled via configureBudget().
 */

import { estimateCost, getTokenUsage } from './token-tracker';

export interface BudgetState {
  /** USD cap; null disables enforcement. */
  limitUsd: number | null;
  /** USD spent so far (computed from token-tracker on demand). */
  spentUsd: number;
  /** True once limit has been exceeded — further calls should refuse. */
  exceeded: boolean;
}

let limitUsd: number | null = null;
let onExceeded: ((info: BudgetState) => void) | undefined;
let exceededFlag = false;

export function configureBudget(opts: {
  limitUsd?: number | null;
  onExceeded?: (info: BudgetState) => void;
}): void {
  if ('limitUsd' in opts) limitUsd = opts.limitUsd ?? null;
  onExceeded = opts.onExceeded;
  exceededFlag = false;
}

export function resetBudget(): void {
  exceededFlag = false;
}

export function getBudgetState(model?: string): BudgetState {
  const spent = estimateCost(model);
  return {
    limitUsd,
    spentUsd: spent,
    exceeded: exceededFlag || (limitUsd != null && spent >= limitUsd),
  };
}

/**
 * Throws BudgetExceededError if the limit has been reached. Call this before
 * each LLM request. No-op when no budget is configured.
 */
export function assertWithinBudget(model?: string): void {
  if (limitUsd == null) return;
  const spent = estimateCost(model);
  if (spent < limitUsd) return;
  if (!exceededFlag) {
    exceededFlag = true;
    if (onExceeded) onExceeded({ limitUsd, spentUsd: spent, exceeded: true });
  }
  throw new BudgetExceededError(limitUsd, spent, getTokenUsage().requests);
}

export class BudgetExceededError extends Error {
  readonly limitUsd: number;
  readonly spentUsd: number;
  readonly requestCount: number;
  constructor(limitUsd: number, spentUsd: number, requestCount: number) {
    super(
      `AI budget exceeded: $${spentUsd.toFixed(4)} spent of $${limitUsd.toFixed(2)} cap ` +
        `over ${requestCount} requests. Increase via configureBudget() or stop the run.`,
    );
    this.name = 'BudgetExceededError';
    this.limitUsd = limitUsd;
    this.spentUsd = spentUsd;
    this.requestCount = requestCount;
  }
}
