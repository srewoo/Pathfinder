/**
 * Page-side assertion evaluation (fix.md §3).
 *
 * Ported faithfully from the former `content/dom-actions.ts` assertion path. The
 * whole condition is evaluated in ONE `Runtime.evaluate` round trip, which both
 * keeps polling cheap and preserves the original semantics exactly — several of
 * which are load-bearing and easy to lose in a rewrite:
 *
 *   - Text and attribute comparisons are CASE-INSENSITIVE and substring-based.
 *     Tightening them to exact matches would fail thousands of existing tests.
 *   - A failed `text` assertion falls back to searching toast/snackbar
 *     containers, because success messages are frequently transient and live
 *     outside the asserted element.
 *   - `visible` additionally rejects `pointer-events: none`, off-viewport
 *     elements, and the two clip-path idioms used to hide content.
 *   - Every error message ends with the page URL; that context is what makes a
 *     failure report actionable.
 */
import { DEEP_QUERY } from './page-scripts';

/** Toast/snackbar containers scanned by the `text` fallback. Order preserved. */
export const TOAST_SELECTORS = [
  '[role="alert"]',
  '[role="status"]',
  '.toast',
  '.Toastify__toast',
  '.MuiSnackbar-root',
  '.MuiAlert-root',
  '.ant-message',
  '.ant-notification',
  '.chakra-toast',
  '.chakra-alert',
  '.notification',
  '.snackbar',
  '[class*="toast"]',
  '[class*="snackbar"]',
] as const;

const ASSERT_HELPERS = `
${DEEP_QUERY}

var __TOASTS = ${JSON.stringify(TOAST_SELECTORS)};

function __visible(el) {
  var rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  var style = getComputedStyle(el);
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden') return false;
  if (style.opacity === '0') return false;
  if (style.pointerEvents === 'none') return false;
  if (rect.bottom < 0 || rect.top > window.innerHeight) return false;
  if (rect.right < 0 || rect.left > window.innerWidth) return false;
  var clip = style.clipPath || style.webkitClipPath;
  if (clip === 'polygon(0px 0px, 0px 0px, 0px 0px, 0px 0px)' || clip === 'inset(100%)') return false;
  return true;
}

function __textInToasts(expected) {
  var want = String(expected || '').toLowerCase();
  for (var i = 0; i < __TOASTS.length; i++) {
    try {
      var nodes = document.querySelectorAll(__TOASTS[i]);
      for (var j = 0; j < nodes.length; j++) {
        var t = (nodes[j].textContent || '').trim().toLowerCase();
        if (t.indexOf(want) !== -1) return true;
      }
    } catch (e) { /* invalid selector — skip */ }
  }
  return false;
}

function __countAll(sel) {
  try { return __deepQueryAll(document, sel, []).length; } catch (e) { return 0; }
}

function __here() { return ' [' + window.location.href + ']'; }

function __checkCondition(el, selector, assertType, expected, attribute) {
  switch (assertType) {
    case 'visible': {
      if (__visible(el)) return { success: true };
      var s = getComputedStyle(el);
      return { success: false, error: 'Element not visible: ' + selector +
        ' (display=' + s.display + ', visibility=' + s.visibility + ', opacity=' + s.opacity + ')' + __here() };
    }
    case 'not_visible':
      return __visible(el)
        ? { success: false, error: 'Element is still visible: ' + selector + __here() }
        : { success: true };

    case 'enabled':
      return el.disabled
        ? { success: false, error: 'Element is disabled: ' + selector + __here() }
        : { success: true };

    case 'disabled':
      return el.disabled
        ? { success: true }
        : { success: false, error: 'Element is not disabled: ' + selector + __here() };

    case 'text': {
      var actual = (el.textContent || '').trim();
      var want = String(expected || '');
      if (actual.toLowerCase().indexOf(want.toLowerCase()) !== -1) return { success: true };
      // Transient success messages often live in a toast, not the asserted node.
      if (__textInToasts(want)) return { success: true };
      var shown = actual.length > 200 ? actual.slice(0, 200) + '...' : actual;
      return { success: false, error: 'Text mismatch: expected to contain "' + want +
        '", got "' + shown + '"' + __here() };
    }

    case 'not_text': {
      var a2 = (el.textContent || '').trim().toLowerCase();
      var w2 = String(expected || '').toLowerCase();
      return a2.indexOf(w2) === -1
        ? { success: true }
        : { success: false, error: 'Text still present: "' + expected + '" found in element' + __here() };
    }

    case 'value': {
      var v = el.value == null ? '' : String(el.value);
      var wv = String(expected || '');
      if (v === wv || v.toLowerCase() === wv.toLowerCase()) return { success: true };
      return { success: false, error: 'Value mismatch: expected "' + wv + '", got "' + v + '"' + __here() };
    }

    case 'attribute': {
      if (!attribute) return { success: false, error: 'No attribute name specified for attribute assertion' };
      var av = el.getAttribute(attribute) || '';
      var wa = String(expected || '');
      if (av.toLowerCase().indexOf(wa.toLowerCase()) !== -1) return { success: true };
      return { success: false, error: 'Attribute [' + attribute + '] mismatch: expected "' + wa +
        '", got "' + av + '"' + __here() };
    }

    case 'count': {
      var n = __countAll(selector);
      var wn = Number(expected == null ? 1 : expected);
      return n >= wn
        ? { success: true }
        : { success: false, error: 'Count assertion failed: expected at least ' + wn + ', got ' + n + __here() };
    }

    case 'exact_count': {
      var ne = __countAll(selector);
      var wne = Number(expected == null ? 1 : expected);
      return ne === wne
        ? { success: true }
        : { success: false, error: 'Exact count mismatch: expected ' + wne + ', got ' + ne + __here() };
    }

    default:
      return { success: false, error: 'Unknown assertType: "' + assertType + '"' };
  }
}
`;

export interface AssertOutcome {
  success: boolean;
  error?: string;
  /** True when the element was absent — lets the caller keep polling. */
  notFound?: boolean;
}

/**
 * Evaluate one assertion attempt.
 *
 * Returns rather than throws so the caller can poll until its deadline; a
 * single attempt failing is expected while the page is still settling.
 */
export function assertExpr(step: {
  selector?: string;
  assertType?: string;
  assertExpected?: string;
  attribute?: string;
}): string {
  const selector = step.selector ?? '';
  const assertType = step.assertType ?? 'visible';
  const expected = step.assertExpected;
  const attribute = step.attribute;

  return `(() => {
    ${ASSERT_HELPERS}
    var selector = ${JSON.stringify(selector)};
    var assertType = ${JSON.stringify(assertType)};
    var expected = ${JSON.stringify(expected ?? null)};
    var attribute = ${JSON.stringify(attribute ?? null)};

    // URL needs no element.
    if (assertType === 'url') {
      var want = String(expected || '');
      var cur = window.location.href;
      if (cur.indexOf(want) !== -1 || cur === want) return { success: true };
      return { success: false, error: 'URL mismatch: expected to include "' + want + '", got "' + cur + '"' };
    }

    if (!selector) return { success: false, error: 'No selector provided for ' + assertType + ' assertion' };

    // Presence assertions are about the DOM, not about visibility.
    if (assertType === 'not_exists') {
      var gone = __deepQuery(document, selector);
      if (gone === null) return { success: true };
      var tag = gone.tagName ? gone.tagName.toLowerCase() : '?';
      var txt = (gone.textContent || '').trim().slice(0, 100);
      return { success: false, error: 'Element still exists in DOM: ' + selector +
        ' (<' + tag + '> "' + txt + '")' + __here() };
    }

    if (assertType === 'exists') {
      return __deepQuery(document, selector) !== null
        ? { success: true }
        : { success: false, notFound: true, error: 'Element not found in DOM: ' + selector + __here() };
    }

    var el = __deepQuery(document, selector);
    if (!el) {
      // A missing element must not fail a text assertion outright — the text may
      // be in a toast that was never inside the asserted node.
      if (assertType === 'text' && expected && __textInToasts(expected)) return { success: true };
      return { success: false, notFound: true, error: 'Element not found: ' + selector + __here() };
    }

    return __checkCondition(el, selector, assertType, expected, attribute);
  })()`;
}

/**
 * Wait for CSS transitions/animations on an element to settle.
 *
 * Kept for `visible` / `not_visible`, where checking mid-animation (opacity
 * 0→1) produces false negatives. Resolves with the milliseconds waited.
 */
export function animationSettleExpr(selector: string, maxWaitMs: number): string {
  return `(() => {
    ${DEEP_QUERY}
    var el = __deepQuery(document, ${JSON.stringify(selector)});
    if (!el) return 0;
    var style = getComputedStyle(el);
    var parse = (v) => Math.max.apply(null, String(v || '0s').split(',').map((p) => {
      p = p.trim();
      var n = parseFloat(p) || 0;
      return p.endsWith('ms') ? n : n * 1000;
    }).concat([0]));
    var total = Math.max(parse(style.transitionDuration), parse(style.animationDuration));
    return Math.min(total, ${Math.max(0, maxWaitMs)});
  })()`;
}
