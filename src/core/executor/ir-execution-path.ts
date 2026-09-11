/**
 * The IR execution path (fix.md §6).
 *
 * Runs a test by converting its plan to validated `TestIR` and executing that,
 * rather than walking `ExecutionStep`s directly. This is the path §6 describes:
 * the executor consumes an artifact that has been through a schema gate, so a
 * malformed plan is a parse error rather than a half-executed test.
 *
 * Offered alongside the legacy path rather than replacing it outright, and the
 * reason is honest: the legacy executor carries behaviour the IR path does not yet
 * have — self-healing, per-test retry ladders, auth recovery, screenshots on
 * failure. Switching wholesale would trade a determinism win for a capability
 * loss. So the IR path is opted into, and `explainPathChoice` says which ran and
 * why.
 */
import type { ExecutionPlan, HealingAttempt, StepResult, TestCase, TestResult } from '../../storage/schemas';
import { describeDropped, testCaseToIR } from '../ir/ir-bridge';
import type { TestIR } from '../ir/test-ir';
import { executeIR, type IRTestResult } from './ir-executor';
import { driverForTab } from '../step-executor';
import type { HealLedger } from '../report/heal-ledger';
import { buildTestabilityReport } from '../report/heal-ledger';
import { generateId } from '../../utils/hash';
import { createLogger } from '../../utils/logger';

const log = createLogger('ir-execution-path');

export interface IrPathOptions {
  runId: string;
  healLedger?: HealLedger;
  signal?: { aborted: boolean };
  now?: () => number;
}

export type PathDecision =
  | { usable: true; ir: TestIR; lossy: string }
  | { usable: false; reason: string };

/**
 * Can this test run through the IR path?
 *
 * Refuses when conversion drops anything. A plan containing `if_visible` or `loop`
 * has no IR representation, and executing the remainder would silently run a
 * DIFFERENT test than the one that was authored — worse than not using the path.
 */
export function evaluateIrPath(testCase: TestCase, plan: ExecutionPlan): PathDecision {
  const { ir, errors, dropped } = testCaseToIR(testCase, plan.steps);

  if (!ir) {
    return { usable: false, reason: `plan does not validate as IR: ${errors.join('; ')}` };
  }
  if (dropped.length > 0) {
    return {
      usable: false,
      reason: `conversion would drop ${dropped.length} step(s) — ${describeDropped(dropped)}`,
    };
  }
  return { usable: true, ir, lossy: '' };
}

/**
 * Execute a test through the IR path.
 *
 * Returns a normal `TestResult` so callers, storage and reporting need no special
 * case — the difference is which engine produced it, not what it looks like.
 */
export async function executeViaIr(
  testCase: TestCase,
  ir: TestIR,
  tabId: number,
  opts: IrPathOptions
): Promise<TestResult> {
  const startedAt = new Date().toISOString();
  const driver = driverForTab(tabId);

  const irResult: IRTestResult = await executeIR(driver, ir, {
    healLedger: opts.healLedger,
    signal: opts.signal,
    now: opts.now,
  });

  const steps = toStepResults(irResult);
  const testability = buildTestabilityReport(irResult.locatorUsages);

  log.info(
    `IR path: "${testCase.title}" → ${irResult.verdict} ` +
      `(${irResult.healedLocatorCount} heal(s), ` +
      `testability ${Math.round(testability.score * 100)}%)`
  );

  return {
    id: generateId(),
    testCaseId: testCase.id,
    testCaseTitle: testCase.title,
    // NEEDS_REVIEW is not a storage status, so it maps to `passed` and the heal
    // evidence below carries the nuance — the verdict is recomputed from that
    // evidence on read, so it must actually be stored. Mapping it to `failed`
    // would break the build over a test that did pass.
    status: irResult.verdict === 'FAIL' ? 'failed' : 'passed',
    startedAt,
    completedAt: new Date().toISOString(),
    duration: irResult.durationMs,
    steps,
    errorMessage: irResult.errorMessage,
    // Reconstructed rather than dropped. This was `[]`, which meant an IR-path
    // NEEDS_REVIEW stored as `passed` with no heal evidence — so the verdict
    // recomputed to a clean PASS and the review was lost everywhere downstream.
    healingAttempts: healingAttemptsFrom(irResult),
    runId: opts.runId,
  };
}

/**
 * Heal evidence in the legacy shape, so the verdict survives storage.
 *
 * The IR result records a heal per step as `{ from, to }`. Only successful heals
 * appear there — a failed heal leaves the step failed — so every reconstructed
 * attempt is `success: true`. The method is `similarity` because the IR result
 * does not record which tier won; the selectors are the reviewable part, and
 * claiming a specific tier we did not observe would be worse than a generic one.
 */
export function healingAttemptsFrom(result: IRTestResult): HealingAttempt[] {
  const out: HealingAttempt[] = [];
  for (const s of [...result.steps, ...result.assertions]) {
    if (!s.healed) continue;
    out.push({
      stepOrder: s.order,
      originalSelector: s.healed.from,
      healedSelector: s.healed.to,
      method: 'similarity',
      success: true,
    });
  }
  return out;
}

/**
 * Flatten IR step and assertion results into legacy `StepResult`s.
 *
 * Assertions become steps because that is how the legacy shape represents them,
 * and keeping one result shape means the UI, storage and exporters stay unchanged.
 */
function toStepResults(result: IRTestResult): StepResult[] {
  const out: StepResult[] = [];

  for (const s of result.steps) {
    out.push({
      step: { order: s.order, action: 'click', description: s.description },
      status: s.status,
      duration: s.durationMs,
      error: s.error,
      healingAttempt: s.healed
        ? {
            stepOrder: s.order,
            originalSelector: s.healed.from,
            method: 'similarity',
            healedSelector: s.healed.to,
            success: true,
          }
        : undefined,
    });
  }

  for (const a of result.assertions) {
    out.push({
      step: { order: 1000 + a.order, action: 'assert', description: a.description },
      status: a.status,
      duration: a.durationMs,
      error: a.error,
    });
  }

  return out;
}

export function explainPathChoice(decision: PathDecision, testTitle: string): string {
  if (decision.usable) {
    return `"${testTitle}" runs on the IR path (plan validated, nothing dropped).`;
  }
  return `"${testTitle}" runs on the legacy path: ${decision.reason}`;
}
