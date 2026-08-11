import { describe, it, expect } from 'vitest';
import {
  NEEDS_REVIEW_HEAL_THRESHOLD,
  buildTestabilityReport,
  createHealLedger,
  explainVerdict,
  formatTestabilityReport,
  verdictFor,
} from '../../../src/core/report/heal-ledger';
import { fromCss, fromRole, fromTestId } from '../../../src/core/locator';

describe('heal ledger', () => {
  it('given_a_heal_then_it_is_recorded_against_the_test', () => {
    const l = createHealLedger();
    l.record(
      { testId: 't1', stepOrder: 2, locatorKey: 'testid:save', target: 'Save', from: 'testid', to: 'semantic' },
      100
    );
    expect(l.forTest('t1')).toHaveLength(1);
    expect(l.events()[0].at).toBe(100);
  });

  it('given_the_same_locator_healed_repeatedly_then_it_counts_once', () => {
    // One flaky locator retried three times is a single testability problem,
    // not three.
    const l = createHealLedger();
    for (let i = 0; i < 3; i++) {
      l.record(
        { testId: 't1', stepOrder: i, locatorKey: 'testid:save', target: 'Save', from: 'testid', to: 'structural' },
        i
      );
    }
    expect(l.healedLocatorCount('t1')).toBe(1);
    expect(l.forTest('t1')).toHaveLength(3);
  });

  it('given_heals_across_tests_then_counts_do_not_bleed_between_them', () => {
    const l = createHealLedger();
    l.record({ testId: 't1', stepOrder: 0, locatorKey: 'a', target: 'a', from: 'testid', to: 'semantic' }, 1);
    l.record({ testId: 't2', stepOrder: 0, locatorKey: 'b', target: 'b', from: 'testid', to: 'semantic' }, 2);
    expect(l.healedLocatorCount('t1')).toBe(1);
    expect(l.healedLocatorCount('t2')).toBe(1);
  });
});

describe('verdictFor', () => {
  it('given_a_clean_pass_then_the_verdict_is_PASS', () => {
    expect(verdictFor(true, 0)).toBe('PASS');
  });

  it('given_a_single_heal_then_it_still_passes', () => {
    expect(verdictFor(true, 1)).toBe('PASS');
  });

  it('given_two_healed_locators_then_the_pass_is_downgraded_to_NEEDS_REVIEW', () => {
    // A pass that leaned on multiple heals may no longer test what it claims.
    expect(verdictFor(true, NEEDS_REVIEW_HEAL_THRESHOLD)).toBe('NEEDS_REVIEW');
  });

  it('given_a_failure_then_heals_do_not_soften_it', () => {
    expect(verdictFor(false, 0)).toBe('FAIL');
    expect(verdictFor(false, 5)).toBe('FAIL');
  });

  it('given_an_explanation_then_it_names_the_heal_count', () => {
    expect(explainVerdict('NEEDS_REVIEW', 3)).toContain('3 locator(s)');
  });
});

describe('buildTestabilityReport', () => {
  it('given_only_durable_locators_then_the_score_is_one_and_there_are_no_gaps', () => {
    const r = buildTestabilityReport([
      { locator: fromTestId('save') },
      { locator: fromRole('button', 'Cancel') },
    ]);
    expect(r.score).toBe(1);
    expect(r.gaps).toEqual([]);
  });

  it('given_a_css_only_locator_then_it_is_reported_as_a_gap', () => {
    const r = buildTestabilityReport([{ locator: fromCss('.btn-primary'), url: 'https://app.test/a' }]);
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0].urls).toEqual(['https://app.test/a']);
    expect(r.score).toBe(0);
  });

  it('given_the_same_gap_on_several_pages_then_usage_and_urls_accumulate', () => {
    const r = buildTestabilityReport([
      { locator: fromCss('.btn'), url: 'https://app.test/a' },
      { locator: fromCss('.btn'), url: 'https://app.test/b' },
      { locator: fromCss('.btn'), url: 'https://app.test/a' },
    ]);
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0].usageCount).toBe(3);
    expect(r.gaps[0].urls).toEqual(['https://app.test/a', 'https://app.test/b']);
  });

  it('given_several_gaps_then_the_most_used_is_listed_first', () => {
    // The ordering IS the remediation plan.
    const r = buildTestabilityReport([
      { locator: fromCss('.rare') },
      { locator: fromCss('.common') },
      { locator: fromCss('.common') },
      { locator: fromCss('.common') },
    ]);
    expect(r.gaps[0].target).toBe('.common');
  });

  it('given_a_mixed_set_then_the_score_is_the_durable_fraction', () => {
    const r = buildTestabilityReport([
      { locator: fromTestId('a') },
      { locator: fromCss('.b') },
      { locator: fromCss('.c') },
      { locator: fromRole('button', 'D') },
    ]);
    expect(r.score).toBe(0.5);
    expect(r.durableLocators).toBe(2);
  });

  it('given_no_locators_then_the_score_is_one_rather_than_NaN', () => {
    expect(buildTestabilityReport([]).score).toBe(1);
  });
});

describe('formatTestabilityReport', () => {
  it('given_no_gaps_then_it_says_so_plainly', () => {
    expect(formatTestabilityReport(buildTestabilityReport([{ locator: fromTestId('a') }]))).toContain(
      'No gaps'
    );
  });

  it('given_gaps_then_it_recommends_data_testid', () => {
    const text = formatTestabilityReport(buildTestabilityReport([{ locator: fromCss('.x') }]));
    expect(text).toContain('data-testid');
    expect(text).toContain('.x');
  });

  it('given_more_gaps_than_the_display_cap_then_the_remainder_is_disclosed', () => {
    // A silent cap reads as "that was everything".
    const usages = Array.from({ length: 40 }, (_, i) => ({ locator: fromCss(`.g${i}`) }));
    const text = formatTestabilityReport(buildTestabilityReport(usages));
    expect(text).toMatch(/and 15 more/);
  });
});
