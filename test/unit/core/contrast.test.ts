/**
 * WCAG contrast ratios.
 *
 * The rule this replaces only fired when foreground and background were IDENTICAL,
 * while citing "1.4.3 Contrast (Minimum)" in the report. Grey-on-grey at 1.2:1
 * passed. A check that names a success criterion it does not implement gives a clean
 * bill of health for the exact defect it exists to find.
 *
 * Ratios below are the published WCAG reference values.
 */
import { describe, it, expect } from 'vitest';
import {
  assessContrast,
  contrastRatio,
  parseCssColor,
  relativeLuminance,
  requiredRatio,
} from '../../../src/core/analysis/contrast';

const BLACK = { r: 0, g: 0, b: 0, a: 1 };
const WHITE = { r: 255, g: 255, b: 255, a: 1 };

describe('the formula', () => {
  it('given_black_on_white_then_the_ratio_is_21', () => {
    expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21, 2);
  });

  it('given_identical_colours_then_the_ratio_is_1', () => {
    expect(contrastRatio(WHITE, WHITE)).toBeCloseTo(1, 5);
  });

  it('given_known_reference_pairs_then_the_ratios_match_published_values', () => {
    // #767676 on white is the canonical "exactly passes AA" grey (4.54:1).
    const grey = parseCssColor('#767676')!;
    expect(contrastRatio(grey, WHITE)).toBeCloseTo(4.54, 1);
    // #949494 on white is 3.03:1 — fails AA for body text, and (only just) passes
    // the 3:1 large-text threshold. Exactly the case a single constant gets wrong.
    expect(contrastRatio(parseCssColor('#949494')!, WHITE)).toBeCloseTo(3.03, 2);
  });

  it('given_luminance_endpoints_then_they_are_0_and_1', () => {
    expect(relativeLuminance(BLACK)).toBeCloseTo(0, 5);
    expect(relativeLuminance(WHITE)).toBeCloseTo(1, 5);
  });
});

describe('the case the old rule missed', () => {
  it('given_grey_on_grey_then_it_FAILS_where_the_identical_only_rule_passed', () => {
    // #777 on #888 — visually unreadable, ratio ~1.2, and previously reported clean.
    const v = assessContrast({
      color: '#777777',
      backgroundColor: '#888888',
      fontSizePx: 14,
      fontWeight: 400,
    });
    expect(v.assessable).toBe(true);
    if (v.assessable) {
      expect(v.ratio).toBeLessThan(1.5);
      expect(v.passes).toBe(false);
    }
  });

  it('given_identical_colours_then_it_still_fails_of_course', () => {
    const v = assessContrast({ color: 'rgb(20, 20, 20)', backgroundColor: 'rgb(20, 20, 20)', fontSizePx: 16, fontWeight: 400 });
    expect(v.assessable && v.passes).toBe(false);
  });
});

describe('thresholds follow the text, not a constant', () => {
  it('given_large_text_then_3_to_1_is_enough', () => {
    // Holding a 32px heading to 4.5:1 would report failures that are not failures.
    expect(requiredRatio(32, 400)).toBe(3);
    expect(requiredRatio(24, 400)).toBe(3);
    expect(requiredRatio(23.9, 400)).toBe(4.5);
  });

  it('given_bold_text_then_the_large_threshold_starts_earlier', () => {
    expect(requiredRatio(19, 700)).toBe(3);
    expect(requiredRatio(19, 400)).toBe(4.5);
  });

  it('given_AAA_then_the_thresholds_rise', () => {
    expect(requiredRatio(16, 400, 'AAA')).toBe(7);
    expect(requiredRatio(32, 400, 'AAA')).toBe(4.5);
  });

  it('given_a_grey_at_3_03_to_1_then_it_passes_as_large_text_and_fails_as_body_text', () => {
    // The whole reason the threshold follows the text: one ratio, two verdicts.
    const sample = { color: '#949494', backgroundColor: '#ffffff', fontWeight: 400 };
    const large = assessContrast({ ...sample, fontSizePx: 32 });
    const body = assessContrast({ ...sample, fontSizePx: 14 });
    expect(large.assessable && body.assessable).toBe(true);
    if (large.assessable && body.assessable) {
      expect(large.ratio).toBeCloseTo(body.ratio, 2);
      expect(large.required).toBe(3);
      expect(large.passes).toBe(true);
      expect(body.required).toBe(4.5);
      expect(body.passes).toBe(false);
    }
  });
});

describe('colour parsing', () => {
  it('given_the_forms_getComputedStyle_returns_then_all_parse', () => {
    expect(parseCssColor('rgb(1, 2, 3)')).toEqual({ r: 1, g: 2, b: 3, a: 1 });
    expect(parseCssColor('rgba(1, 2, 3, 0.5)')).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
    expect(parseCssColor('rgb(1 2 3 / 50%)')).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
    expect(parseCssColor('#abc')).toEqual({ r: 170, g: 187, b: 204, a: 1 });
    expect(parseCssColor('#aabbcc')).toEqual({ r: 170, g: 187, b: 204, a: 1 });
  });

  it('given_a_translucent_foreground_then_it_is_composited_over_the_background', () => {
    // Black at 50% over white is mid-grey, ~3.9:1 — not 21:1.
    const v = assessContrast({ color: 'rgba(0,0,0,0.5)', backgroundColor: '#ffffff', fontSizePx: 16, fontWeight: 400 });
    expect(v.assessable).toBe(true);
    if (v.assessable) {
      expect(v.ratio).toBeGreaterThan(3);
      expect(v.ratio).toBeLessThan(6);
    }
  });
});

describe('what cannot be assessed is declared, not guessed', () => {
  it('given_a_background_image_then_it_reports_unassessable', () => {
    // A gradient has no single colour. Inventing one produces confident nonsense in
    // whichever direction the invention happens to fall.
    const v = assessContrast({ color: '#000', backgroundColor: 'IMAGE', fontSizePx: 16, fontWeight: 400 });
    expect(v.assessable).toBe(false);
  });

  it('given_no_opaque_background_anywhere_then_it_reports_unassessable', () => {
    const v = assessContrast({ color: '#000', backgroundColor: 'rgba(0, 0, 0, 0)', fontSizePx: 16, fontWeight: 400 });
    expect(v.assessable).toBe(false);
    if (!v.assessable) expect(v.reason).toContain('opaque background');
  });

  it('given_fully_transparent_text_then_it_reports_unassessable', () => {
    const v = assessContrast({ color: 'rgba(0,0,0,0)', backgroundColor: '#fff', fontSizePx: 16, fontWeight: 400 });
    expect(v.assessable).toBe(false);
  });
});
