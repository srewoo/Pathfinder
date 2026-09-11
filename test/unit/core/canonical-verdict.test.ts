/**
 * T02 regression: one verdict, computed once, agreeing everywhere.
 *
 * Two systems disagreed. `result-adapter` produced review-aware verdicts for
 * exports, while the side panel's totals and badges read `result.status`
 * directly — so the same run could show a different number of passes in the
 * dashboard than in its own JUnit export, and a NEEDS_REVIEW result was counted
 * as a clean pass in the UI.
 *
 * The fixtures here are the shared set the plan asks for: every case is asserted
 * against the adapter, the summary counts, and the export path together.
 */
import { describe, it, expect } from 'vitest';
import {
  verdictWithReason,
  verdictWithOracles,
  verdictOf,
  summarizeVerdicts,
  isIncomplete,
  toExportRun,
} from '../../../src/core/report/result-adapter';
import type { TestResult, StepResult, ExecutionStep } from '../../../src/storage/schemas';

const step = (order: number, action: ExecutionStep['action'] = 'click'): ExecutionStep => ({
  order,
  action,
  selector: `#s${order}`,
  description: `Step ${order}`,
});

const passedStep = (order: number): StepResult => ({ step: step(order), status: 'passed', duration: 5 });
const failedStep = (order: number): StepResult => ({
  step: step(order),
  status: 'failed',
  duration: 5,
  error: 'Element not found',
});
const skippedStep = (order: number): StepResult => ({ step: step(order), status: 'skipped', duration: 0 });

function result(over: Partial<TestResult> = {}): TestResult {
  return {
    id: 'r1',
    testCaseId: 'tc1',
    testCaseTitle: 'User can sign in',
    status: 'passed',
    startedAt: '2026-09-11T00:00:00.000Z',
    duration: 1200,
    steps: [passedStep(1), passedStep(2)],
    healingAttempts: [],
    runId: 'run1',
    ...over,
  };
}

/** A heal of a distinct selector — two of these reach the review threshold. */
function healedStep(order: number, selector: string): StepResult {
  return {
    step: { ...step(order), selector },
    status: 'passed',
    duration: 5,
    healingAttempt: {
      stepOrder: order,
      originalSelector: selector,
      healedSelector: `${selector}-healed`,
      method: 'similarity',
      success: true,
    },
  };
}

// ── The shared fixture set ──────────────────────────────────────────────────

const CLEAN_PASS = result();

const EXPLICIT_FAILURE = result({
  status: 'failed',
  steps: [passedStep(1), failedStep(2)],
  errorMessage: 'Element not found',
});

const EXECUTION_ERROR = result({ status: 'error', errorMessage: 'Tab crashed' });

const HIGH_SEVERITY_FINDING = result({
  oracleFindings: [
    {
      kind: 'missing-persistence',
      severity: 'high',
      message: 'Banner said saved but nothing was written',
      evidence: 'no network write observed',
      stepOrder: 2,
    },
  ],
});

const LOW_SEVERITY_FINDING = result({
  oracleFindings: [
    { kind: 'slow-response', severity: 'low', message: 'Slow', evidence: '2.1s', stepOrder: 2 },
  ],
});

/** Two DISTINCT healed locators — at the threshold. */
const THRESHOLD_HEALING = result({
  steps: [healedStep(1, '#a'), healedStep(2, '#b')],
});

/** The SAME selector healed twice — one distinct locator, below threshold. */
const REPEATED_SAME_HEAL = result({
  steps: [healedStep(1, '#a'), healedStep(2, '#a')],
});

/**
 * A record stored before T01: raw status `passed`, yet a step visibly failed.
 * Trusting the stored status would keep every such record green forever.
 */
const LEGACY_CONTRADICTORY = result({
  status: 'passed',
  steps: [passedStep(1), failedStep(2)],
});

const STILL_RUNNING = result({ status: 'running', steps: [passedStep(1)] });

/** A resumed run: the skipped prefix is not a failure. */
const RESUMED_WITH_SKIPPED_PREFIX = result({
  status: 'passed',
  steps: [skippedStep(1), passedStep(2), passedStep(3)],
});

describe('verdictWithReason', () => {
  it.each([
    ['clean pass', CLEAN_PASS, 'PASS'],
    ['explicit failure', EXPLICIT_FAILURE, 'FAIL'],
    ['execution error', EXECUTION_ERROR, 'FAIL'],
    ['high-severity finding', HIGH_SEVERITY_FINDING, 'NEEDS_REVIEW'],
    ['low-severity finding', LOW_SEVERITY_FINDING, 'PASS'],
    ['two distinct heals', THRESHOLD_HEALING, 'NEEDS_REVIEW'],
    ['same selector healed twice', REPEATED_SAME_HEAL, 'PASS'],
    ['legacy pass with a failed step', LEGACY_CONTRADICTORY, 'FAIL'],
    ['resumed run with a skipped prefix', RESUMED_WITH_SKIPPED_PREFIX, 'PASS'],
  ] as const)('given_a_%s_then_the_verdict_is_%s', (_name, input, expected) => {
    expect(verdictWithReason(input).verdict).toBe(expected);
  });

  it('given_any_verdict_then_a_human_readable_reason_is_supplied', () => {
    for (const r of [CLEAN_PASS, EXPLICIT_FAILURE, HIGH_SEVERITY_FINDING, THRESHOLD_HEALING]) {
      expect(verdictWithReason(r).reason.length).toBeGreaterThan(0);
    }
  });

  // The reason has to say which of the two review triggers fired, or it cannot
  // be acted on.
  it('given_a_high_severity_finding_then_the_reason_names_the_finding', () => {
    expect(verdictWithReason(HIGH_SEVERITY_FINDING).reason).toMatch(/persist|finding|oracle/i);
  });

  it('given_threshold_healing_then_the_reason_names_the_healed_locators', () => {
    expect(verdictWithReason(THRESHOLD_HEALING).reason).toMatch(/heal/i);
  });

  // A failure outranks a review trigger: the test did not get to the end.
  it('given_both_a_failure_and_a_finding_then_the_verdict_is_FAIL', () => {
    const both = result({
      status: 'failed',
      steps: [failedStep(1)],
      oracleFindings: HIGH_SEVERITY_FINDING.oracleFindings,
    });
    expect(verdictWithReason(both).verdict).toBe('FAIL');
  });
});

describe('lifecycle states are not verdicts', () => {
  // The plan is explicit: an unfinished test must not be labelled a completed
  // failure. Counting it as FAIL would make a run in progress look broken.
  // `running` is the only non-terminal status a stored result can hold; a test
  // that has not started has no result record to assess.
  it('given_a_running_result_then_it_is_incomplete', () => {
    expect(isIncomplete(STILL_RUNNING)).toBe(true);
  });

  it.each([
    ['passed', CLEAN_PASS],
    ['failed', EXPLICIT_FAILURE],
    ['error', EXECUTION_ERROR],
  ] as const)('given_a_terminal_%s_result_then_it_is_not_incomplete', (_name, input) => {
    expect(isIncomplete(input)).toBe(false);
  });
});

describe('summarizeVerdicts', () => {
  const ALL = [
    CLEAN_PASS,
    EXPLICIT_FAILURE,
    EXECUTION_ERROR,
    HIGH_SEVERITY_FINDING,
    THRESHOLD_HEALING,
    LEGACY_CONTRADICTORY,
    STILL_RUNNING,
  ];

  it('given_the_fixture_set_then_each_verdict_has_its_own_count', () => {
    expect(summarizeVerdicts(ALL)).toEqual({
      pass: 1,
      needsReview: 2,
      fail: 3,
      incomplete: 1,
      total: 7,
    });
  });

  // The headline requirement: review-required results must never be folded into
  // the number a user reads as "these are fine".
  it('given_a_needs_review_result_then_it_is_excluded_from_the_pass_count', () => {
    const counts = summarizeVerdicts([CLEAN_PASS, HIGH_SEVERITY_FINDING, THRESHOLD_HEALING]);
    expect(counts.pass).toBe(1);
    expect(counts.needsReview).toBe(2);
  });

  it('given_an_empty_list_then_every_count_is_zero', () => {
    expect(summarizeVerdicts([])).toEqual({
      pass: 0,
      needsReview: 0,
      fail: 0,
      incomplete: 0,
      total: 0,
    });
  });

  it('given_a_summary_then_the_buckets_sum_to_the_total', () => {
    const c = summarizeVerdicts(ALL);
    expect(c.pass + c.needsReview + c.fail + c.incomplete).toBe(c.total);
  });
});

describe('the UI and the export path agree', () => {
  const ALL = [
    CLEAN_PASS,
    EXPLICIT_FAILURE,
    HIGH_SEVERITY_FINDING,
    THRESHOLD_HEALING,
    LEGACY_CONTRADICTORY,
  ];

  // This is the disagreement T02 exists to remove.
  it('given_the_shared_fixture_set_then_per_result_verdicts_match_the_export', () => {
    const exported = toExportRun(ALL);
    for (const [i, r] of ALL.entries()) {
      expect(exported.results[i].verdict).toBe(verdictWithReason(r).verdict);
    }
  });

  it('given_the_shared_fixture_set_then_the_counts_match_the_export', () => {
    const exported = toExportRun(ALL);
    const counts = summarizeVerdicts(ALL);

    expect(exported.results.filter((r) => r.verdict === 'PASS').length).toBe(counts.pass);
    expect(exported.results.filter((r) => r.verdict === 'NEEDS_REVIEW').length).toBe(counts.needsReview);
    expect(exported.results.filter((r) => r.verdict === 'FAIL').length).toBe(counts.fail);
  });

  // Both old entry points must keep answering, and answer the same thing.
  it('given_the_legacy_adapters_then_they_agree_with_the_canonical_verdict', () => {
    for (const r of ALL) {
      expect(verdictWithOracles(r)).toBe(verdictWithReason(r).verdict);
    }
  });

  it('given_a_legacy_contradictory_record_then_verdictOf_no_longer_reports_a_pass', () => {
    expect(verdictOf(LEGACY_CONTRADICTORY)).toBe('FAIL');
  });
});

describe('external formats cannot silently record a clean pass', () => {
  // JUnit has no review state. <system-out> — the previous mapping — is counted
  // as a pass by every CI dashboard, which is the one outcome a review verdict
  // exists to prevent.
  it('given_a_needs_review_result_then_junit_marks_it_skipped_not_passed', async () => {
    const { toJUnitXml } = await import('../../../src/core/report/junit-export');
    const xml = toJUnitXml(toExportRun([THRESHOLD_HEALING]));

    expect(xml).toContain('<skipped');
    expect(xml).toContain('NEEDS_REVIEW');
    // Still not a build failure — the test did what it was told.
    expect(xml).not.toContain('<failure');
  });

  it('given_a_clean_pass_then_junit_marks_neither_skipped_nor_failed', async () => {
    const { toJUnitXml } = await import('../../../src/core/report/junit-export');
    const xml = toJUnitXml(toExportRun([CLEAN_PASS]));

    expect(xml).not.toContain('<skipped');
    expect(xml).not.toContain('<failure');
  });

  it('given_a_failure_then_junit_still_emits_a_failure', async () => {
    const { toJUnitXml } = await import('../../../src/core/report/junit-export');
    expect(toJUnitXml(toExportRun([EXPLICIT_FAILURE]))).toContain('<failure');
  });

  // An oracle-triggered review used to be described as "0 locator(s) healed",
  // which is both wrong and unactionable.
  it('given_an_oracle_triggered_review_then_the_exported_reason_names_the_finding', () => {
    const exported = toExportRun([HIGH_SEVERITY_FINDING]);
    expect(exported.results[0].verdictReason).toMatch(/persist/i);
  });
});

describe('TestRail status mapping', () => {
  // Pushing a review verdict as `passed` would land it in a shared instance as
  // a clean pass. `retest` is the only default status meaning "look again".
  it('given_a_needs_review_result_then_it_pushes_as_retest_not_passed', async () => {
    const { statusIdForResult } = await import('../../../src/core/integrations/testrail-sync');
    const { TESTRAIL_STATUS } = await import('../../../src/core/integrations/testrail-client');

    expect(statusIdForResult(THRESHOLD_HEALING)).toBe(TESTRAIL_STATUS.retest);
    expect(statusIdForResult(HIGH_SEVERITY_FINDING)).toBe(TESTRAIL_STATUS.retest);
  });

  it('given_a_clean_pass_then_it_pushes_as_passed', async () => {
    const { statusIdForResult } = await import('../../../src/core/integrations/testrail-sync');
    const { TESTRAIL_STATUS } = await import('../../../src/core/integrations/testrail-client');
    expect(statusIdForResult(CLEAN_PASS)).toBe(TESTRAIL_STATUS.passed);
  });

  it.each([
    ['explicit failure', () => EXPLICIT_FAILURE],
    ['execution error', () => EXECUTION_ERROR],
    ['legacy contradictory record', () => LEGACY_CONTRADICTORY],
  ])('given_a_%s_then_it_pushes_as_failed', async (_n, get) => {
    const { statusIdForResult } = await import('../../../src/core/integrations/testrail-sync');
    const { TESTRAIL_STATUS } = await import('../../../src/core/integrations/testrail-client');
    expect(statusIdForResult(get())).toBe(TESTRAIL_STATUS.failed);
  });

  // A custom status id (6+) is per-instance and would be wrong anywhere it is
  // not defined.
  it('given_any_verdict_then_only_default_status_ids_are_used', async () => {
    const { statusIdForResult } = await import('../../../src/core/integrations/testrail-sync');
    for (const r of [CLEAN_PASS, THRESHOLD_HEALING, EXPLICIT_FAILURE, EXECUTION_ERROR]) {
      expect(statusIdForResult(r)).toBeLessThanOrEqual(5);
    }
  });
});

describe('the HTML report agrees with the side panel', () => {
  it('given_a_needs_review_result_then_the_html_report_does_not_paint_it_as_passed', async () => {
    const { generateHtmlReport } = await import('../../../src/utils/html-reporter');
    const html = generateHtmlReport([THRESHOLD_HEALING]);

    expect(html).toContain('Needs review');
    expect(html).toContain('review-reason');
    // The card itself must carry the review class, not the pass class.
    expect(html).toContain('<details class="review"');
  });

  it('given_a_mixed_run_then_the_html_counts_match_summarizeVerdicts', async () => {
    const { generateHtmlReport } = await import('../../../src/utils/html-reporter');
    const all = [CLEAN_PASS, THRESHOLD_HEALING, HIGH_SEVERITY_FINDING, EXPLICIT_FAILURE];
    const counts = summarizeVerdicts(all);
    const html = generateHtmlReport(all);

    // Passed: 1, Needs review: 2, Failed: 1 — read back out of the rendered boxes.
    const box = (label: string) =>
      Number(
        new RegExp(`<div class="label">${label}</div>\\s*<div class="value">(\\d+)</div>`).exec(html)?.[1]
      );
    expect(box('Passed')).toBe(counts.pass);
    expect(box('Needs review')).toBe(counts.needsReview);
    expect(box('Failed')).toBe(counts.fail);
  });
});
