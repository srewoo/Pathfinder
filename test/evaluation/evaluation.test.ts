/**
 * The evaluation gate.
 *
 * Two different jobs live here, and the plan is explicit that they are not the
 * same thing:
 *
 *  - **Hard gates.** Zero false positives, and zero false clean passes on the
 *    T01/T02 regression scenarios. These are correctness properties: a detector
 *    that flags a working application is wrong regardless of its recall, and a
 *    green verdict over a failed assertion is the defect P0 fixed. Both fail the
 *    build.
 *  - **A measured baseline.** Detection counts are printed, and asserted only
 *    against the baseline recorded below. The plan requires a measurement before
 *    a recall gate is chosen, so the number is pinned to what was observed
 *    rather than to an aspiration — and pinning it means a regression is caught
 *    without the gate pretending to be a quality target.
 */
import { describe, it, expect } from 'vitest';
import { evaluate, formatReport, FIXTURE_VERSION } from './harness';
import { SCENARIOS } from './scenarios';
import {
  summarizeVerdicts,
  verdictWithReason,
} from '../../src/core/report/result-adapter';
import type { StepResult, TestResult } from '../../src/storage/schemas';

/**
 * The measured baseline, taken on fixtures 1.0.0 on the deterministic-dom tier.
 *
 * Recorded, not chosen. If a change improves detection, raise it deliberately;
 * if it drops, that is a regression the gate should catch. It is not a claim
 * about how good the product is on real applications.
 */
const BASELINE = {
  fixtureVersion: '1.0.0',
  /**
   * Defect-detection scenarios detected on every repeat.
   *
   * Measured at 7 of 7. The eighth scenario measures healing, not detection —
   * its broken variant renames a selector that the locator ladder recovers
   * from, so the test still passes and there is no defect to find. An earlier
   * draft of this baseline said 8, which the first real run immediately
   * contradicted; the number below is what was observed.
   */
  minDetectedScenarios: 7,
  /** Never relaxed. A false positive is wrong whatever the recall. */
  maxFalsePositives: 0,
} as const;

describe('the evaluation runs and reports', () => {
  it('given_the_whole_suite_then_it_produces_a_report_naming_its_tier', async () => {
    const report = await evaluate();

    expect(report.tier).toBe('deterministic-dom');
    // The caveat travels with the numbers, so nobody reads a deterministic
    // result as a statement about Chrome.
    expect(report.caveat).toMatch(/no layout/i);
    expect(report.fixtureVersion).toBe(FIXTURE_VERSION);
    // Every defined scenario is either run or explicitly excluded — nothing is
    // silently dropped. A bare `toHaveLength(SCENARIOS.length)` would break the
    // moment a tier-specific scenario existed, and hide the exclusion.
    expect(report.scenarios.length + report.excluded.length).toBe(SCENARIOS.length);

    // Printed so a CI log carries the measurement, not just a pass.
    // eslint-disable-next-line no-console
    console.log('\n' + formatReport(report) + '\n');
  });

  it('given_a_report_then_every_count_carries_its_denominator', async () => {
    const { totals } = await evaluate({ only: ['save-persists'] });

    expect(totals.brokenRuns).toBeGreaterThan(0);
    expect(totals.correctRuns).toBe(totals.brokenRuns);
    expect(totals.detected + totals.missed).toBeLessThanOrEqual(totals.brokenRuns);
  });

  // A rate with nothing to divide by is absent, not 0% and not 100%.
  it('given_no_scenarios_then_no_rate_is_reported', async () => {
    const { totals } = await evaluate({ only: ['does-not-exist'] });

    expect(totals.scenarios).toBe(0);
    expect(totals.detectionRate).toBeUndefined();
    expect(totals.falsePositiveRate).toBeUndefined();
  });

  // A blind spot must not become a missed defect. The CSS-hidden scenario is in
  // the DOM with no `hidden` attribute and no inline style, so jsdom reads it as
  // visible and would report a working application as broken.
  it('given_a_layout_only_scenario_then_the_deterministic_tier_excludes_it_and_says_so', async () => {
    const report = await evaluate();

    expect(report.excluded.map((e) => e.id)).toContain('css-hidden-confirmation');
    expect(report.excluded[0].requiresTier).toBe('real-browser');
    expect(formatReport(report)).toMatch(/Excluded from this tier/);
    expect(formatReport(report)).toMatch(/needs the \*\*real-browser\*\* tier/);
  });

  // The blind spot itself, demonstrated deliberately: with the exclusion off,
  // the deterministic tier gets this scenario wrong. This is the evidence that
  // the real-browser tier is not redundant.
  it('given_the_exclusion_is_disabled_then_the_deterministic_tier_misses_the_layout_defect', async () => {
    const report = await evaluate({
      only: ['css-hidden-confirmation'],
      skipUnsupported: false,
    });

    expect(report.totals.excludedScenarios).toBe(0);
    expect(report.totals.missed).toBe(1);
    expect(report.totals.detected).toBe(0);
  });

  // No model ran, and "none" is a different claim from "$0.00".
  it('given_the_deterministic_tier_then_model_usage_is_absent_not_zero', async () => {
    const report = await evaluate({ only: ['save-persists'] });

    expect(report.usage).toBeUndefined();
    expect(formatReport(report)).toMatch(/no model was called/i);
  });
});

describe('hard gate: no false positives', () => {
  // A detector that flags a working application is wrong regardless of its
  // recall, and this is the only number in the suite that is never relaxed.
  it('given_the_correct_variant_of_every_scenario_then_nothing_is_flagged', async () => {
    const report = await evaluate();
    const offenders = report.records.filter(
      (r) => r.variant === 'correct' && !r.outcome.inconclusive && r.outcome.defectFound
    );

    expect(
      offenders.map((o) => `${o.scenarioId}: ${o.outcome.detail}`),
      'a scenario flagged the working application'
    ).toEqual([]);
    expect(report.totals.falsePositives).toBeLessThanOrEqual(BASELINE.maxFalsePositives);
  });

  it('given_the_whole_suite_then_no_scenario_crashed', async () => {
    const report = await evaluate();
    const threw = report.records.filter((r) => r.error);

    expect(threw.map((r) => `${r.scenarioId} (${r.variant}): ${r.error}`)).toEqual([]);
  });
});

describe('measured baseline: detection', () => {
  it('given_fixtures_at_the_baseline_version_then_the_baseline_still_applies', () => {
    // A measurement is comparable only to one taken on the same fixtures. If
    // this fails, the baseline needs re-measuring, not overriding.
    expect(FIXTURE_VERSION).toBe(BASELINE.fixtureVersion);
  });

  it('given_the_whole_suite_then_detection_has_not_regressed_below_the_baseline', async () => {
    const report = await evaluate();
    const detectionScenarios = report.scenarios.filter((s) => s.measures === 'defect-detection');
    const fullyDetected = detectionScenarios.filter((s) => s.detected === s.repeats);

    expect(
      fullyDetected.length,
      `scenarios missing their defect: ${detectionScenarios
        .filter((s) => s.detected < s.repeats)
        .map((s) => s.scenarioId)
        .join(', ')}`
    ).toBeGreaterThanOrEqual(BASELINE.minDetectedScenarios);
  });

  // The healing scenario is scored on what it measures: the ladder recovered,
  // the test still passed, and the tier drop was reported rather than hidden.
  it('given_a_renamed_control_then_healing_reaches_it_and_reports_the_tier_drop', async () => {
    const report = await evaluate({ only: ['renamed-control-still-reached'] });
    const broken = report.records.filter((r) => r.variant === 'broken');

    expect(broken.length).toBeGreaterThanOrEqual(5);
    for (const record of broken) {
      // Not a defect: the order was still placed.
      expect(record.outcome.defectFound).toBe(false);
      // But the drop below the preferred tier is stated, which is the
      // testability signal that makes the rename actionable.
      expect(record.outcome.healedToTier).toBe('semantic');
    }
  });

  it('given_the_correct_variant_then_no_healing_was_needed', async () => {
    const report = await evaluate({ only: ['renamed-control-still-reached'] });
    for (const record of report.records.filter((r) => r.variant === 'correct')) {
      expect(record.outcome.healedToTier).toBeUndefined();
    }
  });

  // Repeats exist to expose instability. This does not prove flake freedom and
  // is not reported as if it did.
  it('given_the_repeated_scenarios_then_each_agreed_with_itself_every_time', async () => {
    const report = await evaluate();
    const unstable = report.scenarios.filter((s) => !s.stable);

    expect(unstable.map((s) => s.scenarioId)).toEqual([]);
  });

  it('given_the_timing_and_healing_scenarios_then_they_repeat_at_least_five_times', () => {
    // The plan's floor. A single run of a timing-dependent scenario says
    // nothing about whether it is stable.
    for (const id of [
      'delayed-content-arrives',
      'renamed-control-still-reached',
      'expired-session-reported',
    ]) {
      expect(SCENARIOS.find((s) => s.id === id)?.repeats ?? 1).toBeGreaterThanOrEqual(5);
    }
  });
});

/**
 * The T01/T02 regression scenarios, as verdict fixtures rather than pages.
 *
 * These are the false-clean-pass cases P0 fixed, and the plan requires zero of
 * them regardless of what the rest of the evaluation says. They belong here,
 * not only in the unit suite, because this is the gate a CI job runs to decide
 * whether a verdict regression shipped.
 */
describe('hard gate: zero false clean passes (T01/T02)', () => {
  const step = (status: StepResult['status'], order = 1): StepResult => ({
    step: { order, action: 'click', selector: `#s${order}`, description: `Step ${order}` },
    status,
    duration: 5,
    error: status === 'failed' ? 'Element not found' : undefined,
  });

  function stored(over: Partial<TestResult>): TestResult {
    return {
      id: 'r',
      testCaseId: 'tc',
      testCaseTitle: 'Seeded verdict case',
      status: 'passed',
      startedAt: '2026-09-11T00:00:00.000Z',
      duration: 100,
      steps: [step('passed')],
      healingAttempts: [],
      runId: 'run',
      ...over,
    };
  }

  const SEEDED = [
    {
      name: 'a stored pass whose step failed (the T01 shape)',
      result: stored({ status: 'passed', steps: [step('passed'), step('failed', 2)] }),
    },
    {
      name: 'a stored pass with a failed generated assertion',
      result: stored({
        status: 'passed',
        steps: [
          step('passed'),
          {
            step: { order: 1.5, action: 'assert', selector: '.banner', description: 'Banner shows' },
            status: 'failed',
            duration: 2,
            error: 'Generated assertion failed',
          },
        ],
      }),
    },
    {
      name: 'a pass with a high-severity oracle finding (the T02 shape)',
      result: stored({
        oracleFindings: [
          {
            kind: 'missing-persistence',
            severity: 'high',
            message: 'Banner said saved but nothing was written',
            evidence: 'no network write observed',
            stepOrder: 1,
          },
        ],
      }),
    },
  ] as const;

  it.each(SEEDED)('given_$name_then_it_is_not_reported_as_a_clean_pass', ({ result }) => {
    const { verdict } = verdictWithReason(result);
    expect(verdict).not.toBe('PASS');
  });

  it('given_the_seeded_set_then_none_of_them_lands_in_the_clean_pass_count', () => {
    const counts = summarizeVerdicts(SEEDED.map((s) => s.result));

    // The requirement, stated as one number: zero of these may be counted as
    // fine. A regression in the verdict adapter fails the build here.
    expect(counts.pass).toBe(0);
    expect(counts.needsReview + counts.fail).toBe(SEEDED.length);
  });

  it('given_a_genuinely_clean_pass_then_it_is_still_counted_as_one', () => {
    // The complement, so the gate cannot be satisfied by failing everything.
    expect(summarizeVerdicts([stored({})]).pass).toBe(1);
  });
});
