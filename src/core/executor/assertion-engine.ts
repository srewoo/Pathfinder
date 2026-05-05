import type { ExecutionStep } from '../../storage/schemas';
import { sendToContentScript } from '../../messaging/messenger';

export interface AssertionResult {
  passed: boolean;
  error?: string;
}

export async function runAssertion(
  step: ExecutionStep,
  tabId: number
): Promise<AssertionResult> {
  try {
    const response = await sendToContentScript<{ success: boolean; error?: string }>(tabId, {
      type: 'EXECUTE_ACTION',
      payload: step,
    });

    return {
      passed: response?.success ?? false,
      error: response?.error,
    };
  } catch (err) {
    return {
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
