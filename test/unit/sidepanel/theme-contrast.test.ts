/**
 * Our own palette, measured with our own WCAG checker.
 *
 * We ship an accessibility audit that flags contrast failures, and the panel it ships
 * in failed that audit in both themes: `--text-muted` at 2.37:1 across 125 elements,
 * white-on-amber pills at 2.15:1, and every semantic hue failing as light-mode text.
 *
 * These assertions read the real token values out of `index.css`, so the guard cannot
 * drift from the stylesheet — changing a colour to something illegible fails the build
 * rather than shipping.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assessContrast } from '../../../src/core/analysis/contrast';

const css = readFileSync('src/sidepanel/index.css', 'utf8');

/** Read a custom property from the `:root` (dark) or `.light` block. */
function token(name: string, theme: 'dark' | 'light'): string {
  const blockStart = theme === 'dark' ? css.indexOf(':root {') : css.indexOf('.light {');
  const block = css.slice(blockStart, css.indexOf('}', blockStart));
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(block);
  if (!m) throw new Error(`token --${name} not found in the ${theme} block`);
  const value = m[1].trim();
  // Aliases (`var(--success)`) resolve against the same theme.
  const alias = /^var\(--([\w-]+)\)$/.exec(value);
  return alias ? token(alias[1], theme) : value;
}

/** The smallest size each token is actually used at. */
const BODY = 11;

function ratio(fg: string, bg: string, size = BODY): number {
  const v = assessContrast({ color: fg, backgroundColor: bg, fontSizePx: size, fontWeight: 400 });
  if (!v.assessable) throw new Error(`could not assess ${fg} on ${bg}`);
  return v.ratio;
}

describe.each(['dark', 'light'] as const)('%s theme text on --surface-2', (theme) => {
  const bg = () => token('surface-2', theme);

  it('given_the_three_content_text_tiers_then_each_passes_AA_at_11px', () => {
    // --text-muted is the one that mattered: 125 elements pair it with the smallest
    // size in the app, and at 2.3:1 it read as disabled, collapsing the hierarchy.
    for (const tier of ['text-primary', 'text-secondary', 'text-muted']) {
      expect(ratio(token(tier, theme), bg()), `${theme} --${tier}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('given_the_text_safe_semantic_variants_then_each_passes_AA', () => {
    // The fill/text split exists precisely because the base tokens do NOT pass here.
    for (const name of ['success-text', 'error-text', 'warning-text', 'primary-text', 'info-text']) {
      expect(ratio(token(name, theme), bg()), `${theme} --${name}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('given_a_tier_ordering_then_each_step_is_actually_dimmer_than_the_last', () => {
    // Four named tiers are worthless if two of them look the same. Primary must be
    // clearly stronger than secondary, and secondary than muted.
    const primary = ratio(token('text-primary', theme), bg());
    const secondary = ratio(token('text-secondary', theme), bg());
    const muted = ratio(token('text-muted', theme), bg());
    expect(primary).toBeGreaterThan(secondary * 1.3);
    expect(secondary).toBeGreaterThan(muted * 1.2);
  });

  it('given_text_faint_then_it_is_decoration_and_NOT_used_for_content', () => {
    // Deliberately below AA — it exists so decorative marks stop being written with a
    // content token. Anything failing AA must be unreadable-by-design, not by accident.
    expect(ratio(token('text-faint', theme), bg())).toBeLessThan(4.5);
  });
});

describe('white on a semantic fill', () => {
  it('given_a_mid_tone_semantic_then_white_text_is_NOT_used_on_it', () => {
    // The Positive/Negative/Edge pills used `text-white` on emerald (2.54:1) and amber
    // (2.15:1) — illegible. This records WHY tinted treatments are used instead: white
    // simply does not pass on these hues, so no future change should reintroduce it.
    for (const theme of ['dark', 'light'] as const) {
      expect(ratio('#ffffff', token('success', theme))).toBeLessThan(4.5);
      expect(ratio('#ffffff', token('warning', theme))).toBeLessThan(4.5);
    }
  });

  it('given_the_primary_fill_then_white_text_DOES_pass_on_it', () => {
    // Which is why `bg-primary text-white` is the one inverted treatment kept — the
    // active segment and the primary button rely on it.
    for (const theme of ['dark', 'light'] as const) {
      expect(ratio('#ffffff', token('primary', theme))).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('the panel does not use the raw semantic tokens as text', () => {
  it('given_the_sidepanel_source_then_no_bare_text_success_warning_error_remains', () => {
    // A sweep replaced 87 of these with the `-text` variants. This keeps them out:
    // `text-success` passes in dark and fails at 3.44:1 in light, so reintroducing one
    // would produce a bug only light-theme users ever see.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.tsx')) continue;
        // Only the TEXT utility: bg-, border-, shadow-, ring- and /opacity forms are
        // fills and are meant to use the base token.
        const src = readFileSync(full, 'utf8');
        const rx = /(?<![\w-])text-(warning|success|error|primary-light)(?![\w/-])/g;
        for (const m of src.matchAll(rx)) offenders.push(`${full}: ${m[0]}`);
      }
    };
    walk('src/sidepanel');
    expect(offenders).toEqual([]);
  });
});
