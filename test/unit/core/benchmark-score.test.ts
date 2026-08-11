/**
 * Tests for the benchmark's own scoring (fix.md §10).
 *
 * A scoring bug that flatters the tool is worse than having no benchmark: it
 * converts "we don't know" into false confidence. So the metrics get the same
 * scrutiny as the code they measure.
 */
import { describe, it, expect } from 'vitest';
import {
  THRESHOLDS,
  formatScore,
  gate,
  matchesDefect,
  measureFlake,
  score,
  type FixtureRun,
} from '../../benchmark/score';
import type { Finding } from '../../../src/core/analysis/deterministic-detectors';

const finding = (kind: Finding['kind']): Finding => ({
  kind,
  severity: 'high',
  message: `${kind} detected here`,
  evidence: 'observed during the run',
});

const run = (over: Partial<FixtureRun> = {}): FixtureRun => ({
  fixtureId: 'f1',
  defect: 'validation-bypass',
  onCorrect: [],
  onBroken: [finding('validation-bypass')],
  durationMs: 10,
  tokensUsed: 0,
  ...over,
});

describe('matchesDefect', () => {
  it('given_the_matching_kind_then_it_matches', () => {
    expect(matchesDefect(finding('validation-bypass'), 'validation-bypass')).toBe(true);
  });

  it('given_the_server_error_defect_then_it_maps_to_the_server_error_kind', () => {
    // The defect class and the finding kind are deliberately named differently;
    // the mapping must be explicit.
    expect(matchesDefect(finding('server-error'), 'server-error-on-submit')).toBe(true);
  });

  it('given_a_different_kind_then_it_does_not_match', () => {
    expect(matchesDefect(finding('dead-button'), 'validation-bypass')).toBe(false);
  });

  it('given_a_reworded_message_then_matching_is_unaffected', () => {
    // Matching on message text would make the score a test of phrasing.
    const reworded = { ...finding('dead-button'), message: 'completely different wording' };
    expect(matchesDefect(reworded, 'dead-button')).toBe(true);
  });
});

describe('score', () => {
  it('given_a_caught_defect_and_a_clean_correct_app_then_it_is_perfect', () => {
    const s = score([run()]);
    expect(s.recall).toBe(1);
    expect(s.falsePositives).toBe(0);
    expect(s.precision).toBe(1);
    expect(s.falsePositiveRate).toBe(0);
  });

  it('given_a_missed_defect_then_recall_drops_and_it_counts_as_a_false_negative', () => {
    const s = score([run({ onBroken: [] })]);
    expect(s.recall).toBe(0);
    expect(s.falseNegatives).toBe(1);
    expect(s.truePositives).toBe(0);
  });

  it('given_a_finding_on_the_correct_app_then_it_is_a_false_positive', () => {
    // Any finding on a correct app is spurious by construction — this is the
    // whole reason fixtures are paired.
    const s = score([run({ onCorrect: [finding('dead-button')] })]);
    expect(s.falsePositives).toBe(1);
  });

  it('given_perfect_recall_with_noise_then_precision_still_falls', () => {
    // The property that stops a tool gaming recall by reporting everything.
    const s = score([
      run({ onCorrect: [finding('dead-button'), finding('broken-link')] }),
    ]);
    expect(s.recall).toBe(1);
    expect(s.precision).toBeCloseTo(1 / 3, 5);
    expect(s.falsePositiveRate).toBeCloseTo(2 / 3, 5);
  });

  it('given_incidental_findings_on_the_broken_app_then_they_are_counted_separately', () => {
    // A second finding on a broken app is not a false positive — the app IS
    // broken — but it is worth surfacing, so it gets its own column.
    const s = score([run({ onBroken: [finding('validation-bypass'), finding('dead-button')] })]);
    expect(s.perFixture[0].caught).toBe(true);
    expect(s.perFixture[0].incidentalOnBroken).toBe(1);
    expect(s.falsePositives).toBe(0);
  });

  it('given_no_fixtures_then_metrics_are_zero_rather_than_NaN', () => {
    const s = score([]);
    expect(s.recall).toBe(0);
    expect(s.precision).toBe(0);
    expect(s.falsePositiveRate).toBe(0);
  });

  it('given_several_fixtures_then_duration_and_tokens_sum', () => {
    const s = score([
      run({ fixtureId: 'a', durationMs: 10, tokensUsed: 5 }),
      run({ fixtureId: 'b', durationMs: 20, tokensUsed: 7 }),
    ]);
    expect(s.totalDurationMs).toBe(30);
    expect(s.totalTokens).toBe(12);
  });
});

describe('measureFlake', () => {
  it('given_identical_verdicts_then_flake_is_zero', () => {
    const s = score([run()]);
    expect(measureFlake([s, s, s]).flakeRate).toBe(0);
  });

  it('given_a_verdict_that_changes_between_runs_then_the_fixture_is_flagged_unstable', () => {
    const caught = score([run()]);
    const missed = score([run({ onBroken: [] })]);
    const f = measureFlake([caught, missed]);
    expect(f.unstableFixtures).toEqual(['f1']);
    expect(f.flakeRate).toBe(1);
  });

  it('given_only_message_wording_changing_then_it_is_NOT_flake', () => {
    // Cosmetic churn must not read as instability, or real flake gets buried.
    const a = score([run()]);
    const b = score([
      run({ onBroken: [{ ...finding('validation-bypass'), message: 'different words entirely' }] }),
    ]);
    expect(measureFlake([a, b]).flakeRate).toBe(0);
  });

  it('given_a_single_run_then_flake_is_not_claimed', () => {
    expect(measureFlake([score([run()])]).flakeRate).toBe(0);
    expect(measureFlake([score([run()])]).runs).toBe(1);
  });
});

describe('gate', () => {
  const noFlake = { runs: 3, unstableFixtures: [], flakeRate: 0 };

  it('given_a_perfect_score_then_the_gate_passes', () => {
    expect(gate(score([run()]), noFlake).pass).toBe(true);
  });

  it('given_a_single_false_positive_then_the_gate_fails', () => {
    // Zero-tolerance: these are mechanical checks against ground truth, so any
    // spurious finding is a detector bug rather than acceptable noise.
    const g = gate(score([run({ onCorrect: [finding('dead-button')] })]), noFlake);
    expect(g.pass).toBe(false);
    expect(g.failures[0]).toMatch(/false positive/);
  });

  it('given_recall_below_the_threshold_then_the_gate_fails', () => {
    const runs = [run({ fixtureId: 'a' }), run({ fixtureId: 'b', onBroken: [] })];
    const g = gate(score(runs), noFlake);
    expect(score(runs).recall).toBe(0.5);
    expect(g.pass).toBe(false);
    expect(g.failures.join()).toMatch(/recall/);
  });

  it('given_any_flake_then_the_gate_fails', () => {
    const g = gate(score([run()]), { runs: 3, unstableFixtures: ['f1'], flakeRate: 0.33 });
    expect(g.pass).toBe(false);
    expect(g.failures.join()).toMatch(/flake/);
  });

  it('given_the_thresholds_then_false_positives_are_zero_tolerance', () => {
    expect(THRESHOLDS.maxFalsePositives).toBe(0);
    expect(THRESHOLDS.maxFlakeRate).toBe(0);
  });
});

describe('formatScore', () => {
  it('given_a_score_then_the_report_names_the_key_metrics', () => {
    const text = formatScore(score([run()]), { runs: 3, unstableFixtures: [], flakeRate: 0 });
    expect(text).toContain('Recall:');
    expect(text).toContain('False positives:');
    expect(text).toContain('Flake:');
  });

  it('given_a_false_positive_then_the_report_marks_it_prominently', () => {
    const text = formatScore(score([run({ onCorrect: [finding('dead-button')] })]));
    expect(text).toContain('FALSE POSITIVE');
  });

  it('given_a_missed_defect_then_the_report_lists_it_explicitly', () => {
    const text = formatScore(score([run({ onBroken: [] })]));
    expect(text).toContain('MISSED');
    expect(text).toContain('f1');
  });
});
