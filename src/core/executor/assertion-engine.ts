import type { ExecutionStep } from '../../storage/schemas';
import { executeStep } from '../step-executor';

export interface AssertionResult {
  passed: boolean;
  error?: string;
}

/**
 * Evaluate an assertion step.
 *
 * Routes through the CDP driver (fix.md §3) rather than the content script.
 * Polling and the toast fallback are preserved in `assert-scripts.ts`.
 */
export async function runAssertion(
  step: ExecutionStep,
  tabId: number
): Promise<AssertionResult> {
  try {
    const outcome = await executeStep(step, tabId);
    return { passed: outcome.success, error: outcome.error };
  } catch (err) {
    return {
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
