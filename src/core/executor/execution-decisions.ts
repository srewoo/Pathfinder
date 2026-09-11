/**
 * The decisions the executor makes, separated from the machinery that carries
 * them out.
 *
 * Each function here answers one question about a step, an attempt or a result
 * — is this a submit, how long to wait after that action, what the error
 * message should say, what is worth keeping from a failed attempt — and none of
 * them touches a tab, a database, a driver or a clock. That is what makes them
 * worth having in one place: they are the parts of execution a reader can check
 * by reading, and the parts a test can exercise without a browser.
 *
 * Split out of `test-executor.ts` unchanged.
 */
import type { ExecutionStep, StepResult, TestCase, TestResult, AttemptRecord } from '../../storage/schemas';

/** Steps that can change application state, and therefore warrant a state capture. */
export function isMutatingStep(step: ExecutionStep): boolean {
  return step.action === 'click' || step.action === 'double_click' || step.action === 'press_key';
}

/**
 * Reduce one attempt's result to the evidence worth keeping.
 *
 * No screenshot and no DOM snapshot: three near-identical copies per test is
 * how a result store becomes unusable. The failure text and the order of the
 * first failing step are what make an earlier attempt interpretable, and both
 * are small.
 */
export function recordAttempt(
  result: TestResult,
  attempt: number,
  freshPlan: boolean,
  timeoutMultiplier: number
): AttemptRecord {
  const failedStep = (result.steps ?? []).find((s) => s.status === 'failed');
  const healed = new Set<string>();
  for (const step of result.steps ?? []) {
    if (step.healingAttempt?.success) healed.add(step.healingAttempt.originalSelector);
  }
  return {
    attempt,
    status: result.status === 'running' ? 'error' : result.status,
    durationMs: result.duration ?? 0,
    errorMessage: result.errorMessage,
    failedStepOrder: failedStep?.step.order,
    failedStepError: failedStep?.error,
    healedLocators: healed.size,
    freshPlan,
    timeoutMultiplier,
  };
}

/**
 * Was the step at this order backed by capture when the test was authored?
 *
 * `stepConfidence` is recorded per authored step, in order. Undefined when the
 * test predates confidence tracking or the plan has more steps than the test
 * had — unknown, which must not be reported as either answer.
 */
export function authoringConfidence(testCase: TestCase, stepOrder: number): boolean | undefined {
  const confidences = testCase.stepConfidence;
  if (!confidences || confidences.length === 0) return undefined;
  // Orders are 1-based in authored tests; the executor renumbers from 0, so try
  // both rather than silently mis-indexing by one.
  const candidate = confidences[stepOrder] ?? confidences[stepOrder - 1];
  if (candidate === undefined) return undefined;
  return candidate !== 'inferred';
}

/**
 * Does this step look like a submit?
 *
 * Drives `expectedToWrite`, which flips `missing-persistence` on. Getting it wrong
 * would fire that oracle on every navigation click, so it errs toward silence.
 */
export function isSubmitStep(step: ExecutionStep): boolean {
  const text = `${step.description} ${step.selector ?? ''}`.toLowerCase();
  return /submit|save|create|sign\s?in|log\s?in|register|send|confirm|apply|update|delete/.test(text);
}

// ---------------------------------------------------------------------------
// Build the result error message, folding in an unverified-auth warning when
// the test did not pass (so an auth-caused failure isn't misattributed).
// ---------------------------------------------------------------------------
export function buildErrorMessage(
  finalStatus: TestResult['status'],
  aborted: boolean,
  signalAborted: boolean,
  stepResults: StepResult[],
  authWarning: string | undefined,
  generatedAssertionFailure?: string,
): string | undefined {
  // Cancellation is reported first even when a generated assertion also failed:
  // a run that was stopped did not reach a verdict about the application.
  const base = signalAborted && !aborted
    ? 'Test aborted (per-test time ceiling or run stopped)'
    : aborted
      ? generatedAssertionFailure !== undefined
        // Named as generated, because the user did not write this check. A bare
        // "assertion failed" for a step absent from their test reads as a
        // product defect when it is a generated-assertion gap.
        ? `Generated assertion failed: ${generatedAssertionFailure}`
        : stepResults.findLast((r) => r.error)?.error
      : undefined;
  if (finalStatus !== 'passed' && authWarning) {
    return base ? `${authWarning} | ${base}` : authWarning;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Adaptive step delay — returns ms to wait based on previous step type
// ---------------------------------------------------------------------------
export function getPostStepDelay(previousStep: ExecutionStep | undefined, currentStep: ExecutionStep): number {
  if (!previousStep) return 400; // first step

  switch (previousStep.action) {
    case 'navigate':
      return 1500;
    case 'click':
    case 'double_click':
      // Longer delay before assertions/waits (action result needs to settle)
      return (currentStep.action === 'assert' || currentStep.action === 'wait') ? 800 : 400;
    case 'type':
    case 'clear':
    case 'check':
    case 'uncheck':
    case 'select':
      return 200;
    case 'assert':
    case 'wait':
    case 'scroll':
    case 'hover':
      return 100;
    default:
      return 400;
  }
}
