/**
 * Detection of build-generated class names.
 *
 * `locator.ts` already states the rule — "stable-looking attributes only, never
 * generated/hashed class names" — but nothing enforced it, so the selector
 * ladder's last rung (`.unique-class`) would happily pick
 * `.sc-1e593sq-0.beZfZu`. Those change on every build, so the test breaks on the
 * next deploy and healing pays for it forever. Cheaper to never pick them.
 *
 * Deliberately conservative: a false positive discards a usable selector, which
 * is worse than keeping a brittle one. Every pattern below is anchored to a
 * generator's documented output shape rather than to entropy alone.
 */

/** styled-components component id: `sc-` + base-36 hash + optional `-index`. */
const STYLED_COMPONENTS_ID = /(^|-)sc-[a-z0-9]{5,}(-\d+)?$/i;

/** emotion (`css-1x2y3z`), JSS (`jss42`), goober (`go1234`). */
const CSS_IN_JS_PREFIXED = /^(css|jss|go|emotion)-?\d[a-z0-9]*$/i;

/** CSS modules: `Block_element__hash`. The double underscore is the tell. */
const CSS_MODULE_SUFFIXED = /__[a-z0-9]{4,}$/i;

/**
 * Generic high-entropy token: no separator, and either mixed case with no word
 * boundary or digits interleaved with letters. Catches `beZfZu`, `x1n2onr6`,
 * `a8Kd92Lf` without catching `col6` or `mt4`.
 */
function looksHighEntropy(cls: string): boolean {
  if (cls.length < 5 || cls.length > 24) return false;
  if (/[-_]/.test(cls)) return false;

  const hasUpper = /[A-Z]/.test(cls);
  const hasLower = /[a-z]/.test(cls);
  const digits = (cls.match(/\d/g) ?? []).length;

  // Mixed case with no single word boundary. Authored class attributes are
  // almost always separator-delimited, and a lone `fooBar` is spared.
  const mixedCaseNoBoundary = hasUpper && hasLower && !/^[a-z]+[A-Z][a-z]+$/.test(cls);
  // Digits interleaved with letters rather than a trailing ordinal: `col6` and
  // `mt4` are authored, `x1n2onr6` is not.
  const interleavedDigits = digits >= 2 && !/^[a-z-]+\d{1,2}$/i.test(cls);

  return mixedCaseNoBoundary || interleavedDigits;
}

export function isHashedClassName(cls: string): boolean {
  const trimmed = cls.trim();
  if (!trimmed) return false;
  if (STYLED_COMPONENTS_ID.test(trimmed)) return true;
  if (CSS_IN_JS_PREFIXED.test(trimmed)) return true;
  if (CSS_MODULE_SUFFIXED.test(trimmed)) return true;
  return looksHighEntropy(trimmed);
}

/** Split a `class` attribute and drop every generated name. */
export function stableClassesOf(classAttr: string): string[] {
  return classAttr
    .split(/\s+/)
    .filter((c) => c.length > 0)
    .filter((c) => !isHashedClassName(c));
}

/** Class tokens in a CSS selector. */
const CLASS_TOKEN = /\.(-?[_a-zA-Z][\w-]*)/g;

/**
 * True when a CSS selector's ONLY distinguishing signal is generated class
 * names. Such a selector is worthless past the next deploy.
 *
 * A selector carrying anything else — an id, an attribute, a stable class — is
 * kept: the hash is then redundant decoration, not the load-bearing part.
 */
export function isHashOnlySelector(selector: string): boolean {
  const classes = [...selector.matchAll(CLASS_TOKEN)].map((m) => m[1]);
  if (classes.length === 0) return false;
  if (!classes.every(isHashedClassName)) return false;
  // Any non-class signal rescues it.
  const withoutClasses = selector.replace(CLASS_TOKEN, '').trim();
  return !/[#[]/.test(withoutClasses);
}
