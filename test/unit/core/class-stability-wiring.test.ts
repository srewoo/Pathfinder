import { describe, it, expect } from 'vitest';
import { parseAlternatives } from '../../../src/core/healing/selector-generator';
import { buildTestabilityReport, formatTestabilityReport } from '../../../src/core/report/heal-ledger';
import { fromCss, fromTestId } from '../../../src/core/locator';
import { PROMPTS } from '../../../src/core/ai/prompt-templates';

describe('parseAlternatives', () => {
  it('given_ai_returns_hash_only_selectors_when_parsed_then_they_are_dropped', () => {
    const raw = JSON.stringify({
      alternatives: [
        '.sc-1e593sq-0.beZfZu',
        "[data-testid='save']",
        '.css-1x2y3z',
        'button.save-btn',
      ],
    });
    expect(parseAlternatives(raw)).toEqual(["[data-testid='save']", 'button.save-btn']);
  });

  it('given_all_candidates_hashed_when_parsed_then_empty', () => {
    const raw = JSON.stringify({ alternatives: ['.beZfZu', '.sc-abc12-0'] });
    expect(parseAlternatives(raw)).toEqual([]);
  });

  it('given_a_fenced_response_then_it_still_parses_and_filters', () => {
    const raw = '```json\n' + JSON.stringify({ alternatives: ['.beZfZu', '#save'] }) + '\n```';
    expect(parseAlternatives(raw)).toEqual(['#save']);
  });

  it('given_unparseable_input_then_empty', () => {
    expect(parseAlternatives('sorry, no idea')).toEqual([]);
  });
});

describe('buildTestabilityReport', () => {
  it('given_a_hash_only_structural_locator_then_the_gap_is_flagged_as_a_build_hash', () => {
    const report = buildTestabilityReport([{ locator: fromCss('.sc-1e593sq-0.beZfZu') }]);
    expect(report.gaps).toHaveLength(1);
    expect(report.gaps[0].buildHashOnly).toBe(true);
  });

  it('given_a_structural_locator_with_an_authored_class_then_it_is_a_gap_but_not_a_build_hash', () => {
    const report = buildTestabilityReport([{ locator: fromCss('.login-container .primary-btn') }]);
    expect(report.gaps).toHaveLength(1);
    expect(report.gaps[0].buildHashOnly).toBe(false);
  });

  it('given_a_testid_locator_then_it_is_durable_and_produces_no_gap', () => {
    const report = buildTestabilityReport([{ locator: fromTestId('save') }]);
    expect(report.gaps).toEqual([]);
    expect(report.durableLocators).toBe(1);
  });

  // A hash-only locator is strictly worse than a merely-structural one: it is
  // guaranteed to break, not just likely to. The report has to say so.
  it('given_both_kinds_of_gap_then_the_report_calls_out_the_build_hash_ones', () => {
    const report = buildTestabilityReport([
      { locator: fromCss('.login-container .primary-btn') },
      { locator: fromCss('.sc-1e593sq-0.beZfZu') },
    ]);
    const text = formatTestabilityReport(report);
    expect(text).toMatch(/generated class name/i);
    expect(text).toMatch(/next build/i);
  });

  it('given_no_build_hash_gaps_then_the_report_does_not_mention_them', () => {
    const report = buildTestabilityReport([{ locator: fromCss('.login-container .primary-btn') }]);
    expect(formatTestabilityReport(report)).not.toMatch(/generated class name/i);
  });
});

describe('prompt guidance', () => {
  it.each(['testPlanning', 'selectorHealing'] as const)(
    'given_the_%s_prompt_then_it_names_the_generated_class_prohibition',
    (key) => {
      expect(PROMPTS[key].system).toMatch(/styled-components/i);
      expect(PROMPTS[key].system).toMatch(/every deploy|next build/i);
    }
  );
});
