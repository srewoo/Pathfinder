/**
 * T06 regression: a fail-then-pass must be able to explain itself.
 *
 * The retry ladder makes up to three attempts and returned only the last one.
 * Everything about the earlier ones — what failed, at which step, whether a
 * locator had to be healed, whether the plan was regenerated — was computed and
 * then discarded, so a test that passed on its third try was indistinguishable
 * from one that passed first time. That is the clearest flakiness signal a run
 * produces.
 */
import { describe, it, expect } from 'vitest';
import { retrySummary, toExportRun, verdictWithReason } from '../../../src/core/report/result-adapter';
import { toJUnitXml } from '../../../src/core/report/junit-export';
import type { AttemptRecord, TestResult } from '../../../src/storage/schemas';

function attempt(over: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    attempt: 0,
    status: 'failed',
    durationMs: 1200,
    errorMessage: 'Element #save not found',
    failedStepOrder: 2,
    failedStepError: 'Element #save not found',
    healedLocators: 0,
    freshPlan: false,
    timeoutMultiplier: 1,
    ...over,
  };
}

function result(attempts?: AttemptRecord[], status: TestResult['status'] = 'passed'): TestResult {
  return {
    id: 'r1',
    testCaseId: 'tc1',
    testCaseTitle: 'User can save',
    status,
    startedAt: '2026-09-11T00:00:00.000Z',
    duration: 3600,
    steps: [],
    healingAttempts: [],
    runId: 'run1',
    attempts,
  };
}

/** Failed twice, passed on the third — the fixture the plan asks for. */
const FAIL_FAIL_PASS = result([
  attempt({ attempt: 0 }),
  attempt({ attempt: 1, timeoutMultiplier: 2 }),
  attempt({
    attempt: 2,
    status: 'passed',
    freshPlan: true,
    healedLocators: 1,
    errorMessage: undefined,
    failedStepOrder: undefined,
    failedStepError: undefined,
  }),
]);

describe('retrySummary', () => {
  it('given_a_fail_fail_pass_then_it_reports_which_attempt_passed', () => {
    const summary = retrySummary(FAIL_FAIL_PASS)!;

    expect(summary.attempts).toBe(3);
    expect(summary.passedOnAttempt).toBe(2);
    expect(summary.retriedToPass).toBe(true);
    expect(summary.label).toBe('Passed on attempt 3 of 3');
  });

  // Absence means not retried, not unknown: a first-attempt pass stores no
  // ledger, and neither does a record written before this was tracked.
  it.each([
    ['no ledger', undefined],
    ['a single-entry ledger', [attempt({ attempt: 0, status: 'passed' })]],
  ])('given_%s_then_there_is_no_retry_summary', (_name, attempts) => {
    expect(retrySummary(result(attempts))).toBeUndefined();
  });

  it('given_every_attempt_failed_then_it_says_so_and_is_not_a_retry_to_pass', () => {
    const summary = retrySummary(
      result([attempt({ attempt: 0 }), attempt({ attempt: 1 }), attempt({ attempt: 2 })], 'failed')
    )!;

    expect(summary.retriedToPass).toBe(false);
    expect(summary.passedOnAttempt).toBeUndefined();
    expect(summary.label).toBe('Failed after 3 attempts');
  });
});

describe('the earlier attempts keep their evidence', () => {
  it('given_a_retried_result_then_each_attempt_names_its_failing_step', () => {
    const attempts = FAIL_FAIL_PASS.attempts!;

    expect(attempts[0].failedStepOrder).toBe(2);
    expect(attempts[0].failedStepError).toContain('#save');
  });

  // The ladder's two strategies must be distinguishable, or "it passed
  // eventually" says nothing about why.
  it('given_the_ladder_then_the_timing_fix_and_the_replan_are_distinguishable', () => {
    const attempts = FAIL_FAIL_PASS.attempts!;

    expect(attempts[1].timeoutMultiplier).toBe(2);
    expect(attempts[1].freshPlan).toBe(false);
    expect(attempts[2].freshPlan).toBe(true);
  });

  it('given_a_healed_attempt_then_the_heal_count_is_retained', () => {
    expect(FAIL_FAIL_PASS.attempts![2].healedLocators).toBe(1);
  });

  // Three near-identical screenshots per test is how a result store becomes
  // unusable. The final result keeps the one that matters.
  it('given_an_attempt_record_then_it_carries_no_large_artifact', () => {
    for (const a of FAIL_FAIL_PASS.attempts!) {
      expect(a).not.toHaveProperty('screenshot');
      expect(a).not.toHaveProperty('domSnapshot');
      expect(a).not.toHaveProperty('steps');
    }
  });
});

describe('retrying is kept separate from the review verdict', () => {
  // Promoting a retry to NEEDS_REVIEW would need a stated policy about how much
  // retrying is acceptable, and inventing one would silently reclassify a large
  // share of existing passes.
  it('given_a_clean_pass_after_retries_then_the_verdict_is_still_PASS', () => {
    expect(verdictWithReason(FAIL_FAIL_PASS).verdict).toBe('PASS');
  });

  it('given_a_retry_then_the_verdict_reason_does_not_mention_it', () => {
    expect(verdictWithReason(FAIL_FAIL_PASS).reason).not.toMatch(/attempt/i);
  });
});

describe('exports carry the retry history', () => {
  it('given_a_retried_result_then_the_export_includes_its_summary', () => {
    const exported = toExportRun([FAIL_FAIL_PASS]);
    expect(exported.results[0].retry).toMatchObject({ attempts: 3, retriedToPass: true });
  });

  it('given_a_first_attempt_pass_then_the_export_carries_no_retry', () => {
    expect(toExportRun([result()]).results[0].retry).toBeUndefined();
  });

  // Stated, but not as a status — a retry must not turn a pass into a failure
  // or a skip in CI.
  it('given_a_retried_pass_then_junit_states_it_without_changing_the_status', () => {
    const xml = toJUnitXml(toExportRun([FAIL_FAIL_PASS]));

    expect(xml).toContain('RETRY: Passed on attempt 3 of 3');
    expect(xml).not.toContain('<failure');
    expect(xml).not.toContain('<skipped');
  });
});
