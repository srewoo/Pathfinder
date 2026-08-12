/**
 * WCAG contrast ratios (SC 1.4.3 / 1.4.6).
 *
 * The audit previously claimed to check 1.4.3 while only detecting text whose
 * foreground and background were *identical* — a condition that essentially never
 * occurs in shipped CSS. Grey-on-grey at a ratio of 1.2 passed, and the report
 * still cited "1.4.3 Contrast (Minimum)" next to it. A check that names a success
 * criterion it does not implement is worse than no check: it produces a clean bill
 * of health for the exact defect it is supposed to find.
 *
 * This is the real formula: relative luminance per WCAG, and the threshold that
 * actually applies to the text in question — large text is held to 3:1, everything
 * else to 4.5:1.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
  /** 0–1. Fully transparent colours cannot be assessed. */
  a: number;
}

/** Parse the colour forms `getComputedStyle` actually returns, plus hex. */
export function parseCssColor(value: string): Rgb | null {
  const v = (value ?? '').trim().toLowerCase();
  if (!v || v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };

  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(v);
  if (rgb) {
    const alphaRaw = rgb[4];
    const a = alphaRaw === undefined
      ? 1
      : alphaRaw.endsWith('%')
        ? parseFloat(alphaRaw) / 100
        : parseFloat(alphaRaw);
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: isNaN(a) ? 1 : a };
  }

  const hex = /^#([0-9a-f]{3,8})$/.exec(v);
  if (hex) {
    const h = hex[1];
    const expand = (s: string): number => parseInt(s.length === 1 ? s + s : s, 16);
    if (h.length === 3 || h.length === 4) {
      return {
        r: expand(h[0]), g: expand(h[1]), b: expand(h[2]),
        a: h.length === 4 ? expand(h[3]) / 255 : 1,
      };
    }
    if (h.length === 6 || h.length === 8) {
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      };
    }
  }
  return null;
}

/** Composite a possibly-translucent foreground over an opaque backdrop. */
export function flatten(fg: Rgb, bg: Rgb): Rgb {
  if (fg.a >= 1) return { ...fg, a: 1 };
  const mix = (f: number, b: number): number => Math.round(f * fg.a + b * (1 - fg.a));
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a: 1 };
}

/** WCAG relative luminance. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contrast ratio between two colours, 1–21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The threshold that applies to this text.
 *
 * WCAG "large text" is 18pt (24px), or 14pt (18.66px) when bold. Applying 4.5:1 to
 * a 32px heading would report failures that are not failures.
 */
export function requiredRatio(fontSizePx: number, fontWeight: number, level: 'AA' | 'AAA' = 'AA'): number {
  const isBold = fontWeight >= 700;
  const isLarge = fontSizePx >= 24 || (isBold && fontSizePx >= 18.66);
  if (level === 'AAA') return isLarge ? 4.5 : 7;
  return isLarge ? 3 : 4.5;
}

export interface ContrastSample {
  color: string;
  backgroundColor: string;
  fontSizePx: number;
  fontWeight: number;
}

export type ContrastAssessment =
  | { assessable: false; reason: string }
  | { assessable: true; ratio: number; required: number; passes: boolean; isLargeText: boolean };

/**
 * Assess one text sample.
 *
 * Returns `assessable: false` rather than a guess when the colours cannot be
 * resolved — a background image or gradient has no single colour, and inventing one
 * would produce confident nonsense in either direction.
 */
export function assessContrast(sample: ContrastSample, level: 'AA' | 'AAA' = 'AA'): ContrastAssessment {
  const fg = parseCssColor(sample.color);
  const bg = parseCssColor(sample.backgroundColor);
  if (!fg) return { assessable: false, reason: `unparseable text colour "${sample.color}"` };
  if (!bg) return { assessable: false, reason: `unparseable background "${sample.backgroundColor}"` };
  if (bg.a === 0) {
    return { assessable: false, reason: 'no opaque background found behind the text' };
  }
  if (fg.a === 0) return { assessable: false, reason: 'text colour is fully transparent' };

  const flatBg = { ...bg, a: 1 };
  const ratio = contrastRatio(flatten(fg, flatBg), flatBg);
  const required = requiredRatio(sample.fontSizePx, sample.fontWeight, level);
  return {
    assessable: true,
    ratio: Math.round(ratio * 100) / 100,
    required,
    passes: ratio >= required,
    isLargeText: required === (level === 'AAA' ? 4.5 : 3),
  };
}
