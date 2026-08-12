/**
 * Explorer coverage audit — paste into DevTools on any page.
 *
 * Answers one question: of the things a USER can click on this page, how many
 * would Pathfinder's explorer see, and how many would it actually click?
 *
 * The logic below is copied from the shipping code, not approximated:
 *   INTERACTIVE_SELECTOR + isPseudoClickable  → src/content/element-detector.ts
 *   CLICKABLE_TAGS / ROLES / FORM_TAGS        → src/core/explorer/page-scanner.ts
 *
 * Keep it that way. An audit that drifts from the implementation measures the
 * audit.
 *
 * Usage: paste, then `await auditPageCoverage()`.
 */
window.auditPageCoverage = function auditPageCoverage() {
  const INTERACTIVE_SELECTOR = [
    'button:not([disabled])', 'a[href]', 'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])', 'textarea:not([disabled])', '[role="button"]:not([disabled])',
    '[role="link"]', '[role="menuitem"]', '[role="tab"]', '[role="checkbox"]',
    '[role="radio"]', '[role="switch"]', '[tabindex]:not([tabindex="-1"])',
    '[role="combobox"]', '[role="listbox"]', '[role="slider"]', '[contenteditable="true"]',
  ].join(',');

  const PSEUDO_TAGS = ['div', 'span', 'li', 'td'];
  const isPseudoClickable = (el) => {
    if (!PSEUDO_TAGS.includes(el.tagName.toLowerCase())) return false;
    if (el.childElementCount > 2) return false;
    const t = (el.textContent || '').trim();
    if (t.length < 1 || t.length > 60) return false;
    if (el.hasAttribute('onclick')) return true;
    if (getComputedStyle(el).cursor !== 'pointer') return false;
    if (el.querySelector(INTERACTIVE_SELECTOR)) return false;
    return true;
  };

  const rendered = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };

  /**
   * A user's notion of "clickable": native semantics, an ARIA role, or the
   * pointer cursor the app itself uses to advertise clickability.
   *
   * Excludes anything nested inside an already-interactive element. An `<svg>`
   * (and its `<g>`, its `<path>`) inside a `<button>` inherits `cursor: pointer`,
   * so counting them inflated the miss list with four rows per icon that clicking
   * the button already covers. A padded denominator makes coverage look worse than
   * it is, which is as misleading as making it look better.
   */
  const hasInteractiveAncestor = (el) => {
    let p = el.parentElement;
    while (p && p !== document.body) {
      if (p.matches(INTERACTIVE_SELECTOR) || isPseudoClickable(p)) return true;
      p = p.parentElement;
    }
    return false;
  };

  const isUserInteractive = (el) => {
    if (!rendered(el)) return false;
    if (el.matches(INTERACTIVE_SELECTOR)) return !hasInteractiveAncestor(el);
    if (getComputedStyle(el).cursor !== 'pointer') return false;
    if ((el.textContent || '').trim().length >= 80) return false;
    return !hasInteractiveAncestor(el);
  };

  const CLICKABLE_TAGS = new Set(['button', 'a']);
  const CLICKABLE_ROLES = new Set(['button', 'tab', 'menuitem', 'link']);
  const FORM_TAGS = new Set(['input', 'select', 'textarea']);
  const TOGGLE_TYPES = new Set(['checkbox', 'radio']);
  const TOGGLE_ROLES = new Set(['checkbox', 'radio', 'switch']);
  const DANGEROUS = /\b(delete|remove|logout|sign out|cancel subscription)\b/i;

  const all = [...document.querySelectorAll('*')];
  const userInteractive = all.filter(isUserInteractive);
  const detected = userInteractive.filter((el) => el.matches(INTERACTIVE_SELECTOR) || isPseudoClickable(el));
  const missed = userInteractive.filter((el) => !detected.includes(el));

  const clickTargets = detected.filter((el) => {
    const tag = el.tagName.toLowerCase();
    if (FORM_TAGS.has(tag)) return false;
    const role = el.getAttribute('role') || (isPseudoClickable(el) ? 'button' : '');
    if (!CLICKABLE_TAGS.has(tag) && !CLICKABLE_ROLES.has(role)) return false;
    return !DANGEROUS.test(el.textContent || '');
  });

  const toggles = detected.filter((el) => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    return (tag === 'input' && TOGGLE_TYPES.has(type)) || TOGGLE_ROLES.has(el.getAttribute('role') || '');
  });

  const dangerousSkipped = detected.filter((el) => DANGEROUS.test(el.textContent || ''));

  const component = (el) => {
    const cls = (el.className || '').toString().split(/\s+/).find((c) => c.startsWith('oxd-') || c.startsWith('MuiButton'));
    return cls || `<${el.tagName.toLowerCase()}>`;
  };
  const tally = (list) => list.reduce((acc, el) => {
    const k = component(el);
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});

  const result = {
    url: location.pathname + location.search,
    title: document.title,
    userInteractive: userInteractive.length,
    detected: detected.length,
    wouldClick: clickTargets.length,
    toggles: toggles.length,
    dangerousSkipped: dangerousSkipped.length,
    // The number that matters: user-clickable things the scanner cannot see.
    invisibleToScanner: missed.length,
    missedByComponent: tally(missed),
    missedSamples: missed.slice(0, 12).map((el) => ({
      tag: el.tagName.toLowerCase(),
      component: component(el),
      role: el.getAttribute('role'),
      children: el.childElementCount,
      text: (el.textContent || '').trim().slice(0, 40),
    })),
    // Cross-origin iframes are opaque to the content script by design.
    crossOriginFrames: [...document.querySelectorAll('iframe')].filter((f) => {
      try { return !f.contentDocument; } catch { return true; }
    }).length,
  };
  console.table({ summary: result });
  return result;
};
