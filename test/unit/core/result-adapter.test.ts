/**
 * §5 heal reporting through the LEGACY pipeline (fix.md §5, §11).
 *
 * The gap this closes: `StepResult.healingAttempt` has always recorded heals, and
 * nothing ever surfaced them. Healing was not missing — it was silent, which is
 * the failure mode §5 calls the worst this product has.
 */
import { describe, it, expect } from 'vitest';
import {
  approximateTestability,
  healedLocatorCount,
  toExportResult,
  toExportRun,
  verdictOf,
} from '../../../src/core/report/result-adapter';
import { toJUnitXml } from '../../../src/core/report/junit-export';
import type { StepResult, TestResult } from '../../../src/storage/schemas';

const step = (over: Partial<StepResult> = {}): StepResult => ({
  step: { order: 0, action: 'click', description: 'Click Save', selector: '#save' },
  status: 'passed',
  duration: 10,
  ...over,
});

const heal = (originalSelector: string, healedSelector = '.save-btn') => ({
  stepOrder: 0,
  originalSelector,
  method: 'similarity' as const,
  healedSelector,
  success: true,
});

const result = (over: Partial<TestResult> = {}): TestResult => ({
  id: 'r1',
  testCaseId: 't1',
  testCaseTitle: 'User can save',
  status: 'passed',
  startedAt: '2026-08-11T10:00:00.000Z',
  duration: 500,
  steps: [step()],
  healingAttempts: [],
  runId: 'run-1',
  ...over,
});

describe('healedLocatorCount', () => {
  it('given_a_run_level_heal_record_then_it_is_also_counted', () => {
    // TestResult carries BOTH per-step and run-level heal records; reading only
    // one undercounts depending on which path recorded it.
    expect(healedLocatorCount([step()], [heal('#run-level')])).toBe(1);
  });

  it('given_the_same_selector_in_both_sources_then_it_counts_once', () => {
    expect(healedLocatorCount([step({ healingAttempt: heal('#save') })], [heal('#save')])).toBe(1);
  });

  it('given_no_heals_then_the_count_is_zero', () => {
    expect(healedLocatorCount([step()])).toBe(0);
  });

  it('given_one_healed_step_then_the_count_is_one', () => {
    expect(healedLocatorCount([step({ healingAttempt: heal('#save') })])).toBe(1);
  });

  it('given_the_same_locator_healed_repeatedly_then_it_counts_once', () => {
    // One flaky locator retried three times is a single testability problem.
    const steps = [
      step({ healingAttempt: heal('#save') }),
      step({ healingAttempt: heal('#save') }),
      step({ healingAttempt: heal('#save') }),
    ];
    expect(healedLocatorCount(steps)).toBe(1);
  });

  it('given_a_failed_heal_attempt_then_it_is_not_counted', () => {
    // A heal that did not work is a failure, reported as such elsewhere; counting
    // it here would double-penalise.
    const failed = { ...heal('#save'), success: false };
    expect(healedLocatorCount([step({ healingAttempt: failed })])).toBe(0);
  });
});

describe('verdictOf', () => {
  it('given_a_clean_pass_then_PASS', () => {
    expect(verdictOf(result())).toBe('PASS');
  });

  it('given_a_pass_with_one_heal_then_still_PASS', () => {
    expect(verdictOf(result({ steps: [step({ healingAttempt: heal('#a') })] }))).toBe('PASS');
  });

  it('given_a_pass_with_two_healed_locators_then_NEEDS_REVIEW', () => {
    // The §5 guarantee, now live in the legacy pipeline.
    const r = result({
      steps: [step({ healingAttempt: heal('#a') }), step({ healingAttempt: heal('#b') })],
    });
    expect(verdictOf(r)).toBe('NEEDS_REVIEW');
  });

  it('given_a_failed_test_then_heals_do_not_change_FAIL', () => {
    const r = result({
      status: 'failed',
      steps: [step({ healingAttempt: heal('#a') }), step({ healingAttempt: heal('#b') })],
    });
    expect(verdictOf(r)).toBe('FAIL');
  });
});

describe('toExportResult', () => {
  it('given_a_healed_step_then_the_export_records_the_selector_transition', () => {
    const r = toExportResult(result({ steps: [step({ healingAttempt: heal('#save', '.btn') })] }));
    expect(r.steps[0].healed).toEqual({ from: '#save', to: '.btn' });
  });

  it('given_a_heal_with_no_recorded_replacement_then_it_is_marked_unknown_not_dropped', () => {
    const partial = { ...heal('#save'), healedSelector: undefined };
    const r = toExportResult(result({ steps: [step({ healingAttempt: partial })] }));
    expect(r.steps[0].healed?.to).toBe('(unknown)');
  });
});

describe('toExportRun', () => {
  it('given_results_then_duration_sums_and_startedAt_comes_from_the_first', () => {
    const run = toExportRun([result({ duration: 100 }), result({ id: 'r2', duration: 250 })]);
    expect(run.durationMs).toBe(350);
    expect(run.startedAt).toBe('2026-08-11T10:00:00.000Z');
  });

  it('given_no_results_then_it_does_not_throw', () => {
    expect(() => toExportRun([])).not.toThrow();
  });
});

describe('JUnit output now carries the heal signal', () => {
  it('given_a_healed_pass_then_the_xml_reports_NEEDS_REVIEW_without_failing_the_build', () => {
    const xml = toJUnitXml(
      toExportRun([
        result({
          steps: [step({ healingAttempt: heal('#a') }), step({ healingAttempt: heal('#b') })],
        }),
      ])
    );
    expect(xml).toContain('NEEDS_REVIEW');
    expect(xml).toContain('failures="0"');
    expect(xml).toContain('pathfinder.needsReview" value="1"');
  });

  it('given_a_clean_pass_then_no_review_note_appears', () => {
    const xml = toJUnitXml(toExportRun([result()]));
    expect(xml).not.toContain('NEEDS_REVIEW');
  });
});

describe('approximateTestability', () => {
  it('given_a_testid_selector_then_it_counts_as_durable', () => {
    const r = result({
      steps: [
        step({ step: { order: 0, action: 'click', description: 'x', selector: '[data-testid="save"]' } }),
      ],
    });
    expect(approximateTestability([r]).score).toBe(1);
    expect(approximateTestability([r]).gaps).toEqual([]);
  });

  it('given_a_css_selector_then_it_is_reported_as_a_gap', () => {
    const gaps = approximateTestability([result()]).gaps;
    expect(gaps).toHaveLength(1);
    expect(gaps[0].target).toBe('#save');
  });

  it('given_steps_without_selectors_then_they_are_ignored', () => {
    const r = result({
      steps: [step({ step: { order: 0, action: 'navigate', description: 'go', value: 'https://a/' } })],
    });
    expect(approximateTestability([r]).totalLocators).toBe(0);
  });

  it('given_the_same_gap_twice_then_usage_accumulates', () => {
    const r = result({ steps: [step(), step()] });
    expect(approximateTestability([r]).gaps[0].usageCount).toBe(2);
  });
});
