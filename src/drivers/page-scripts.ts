/**
 * Page-side scripts injected by the CDP driver.
 *
 * These are strings evaluated in the page via `Runtime.evaluate`. This is the
 * legitimate home for DOM *analysis* — accessible-name computation, occlusion
 * hit-testing, sticky-header offsets, overlay classification. Only event
 * *dispatch* moves to CDP `Input.*`; analysis must run where the DOM lives.
 *
 * Much of this is ported from the former `content/dom-actions.ts`, which had
 * accumulated hard-won handling for MUI backdrops, sticky headers and custom
 * dropdowns. That knowledge is preserved here rather than rewritten.
 */

/** Shadow-DOM piercing query. Kept identical in behaviour to the CDP client's. */
export const DEEP_QUERY = `
function __deepQuery(root, sel) {
  try { const el = root.querySelector(sel); if (el) return el; } catch (e) { return null; }
  const all = root.querySelectorAll('*');
  for (const host of all) {
    if (host.shadowRoot) { const f = __deepQuery(host.shadowRoot, sel); if (f) return f; }
  }
  return null;
}
function __deepQueryAll(root, sel, out) {
  out = out || [];
  try { root.querySelectorAll(sel).forEach((e) => out.push(e)); } catch (e) { return out; }
  root.querySelectorAll('*').forEach((host) => {
    if (host.shadowRoot) __deepQueryAll(host.shadowRoot, sel, out);
  });
  return out;
}
`;

/**
 * Implicit ARIA role mapping, plus accessible-name computation.
 *
 * Deliberately a pragmatic subset of the full accname spec — it covers the
 * cases that appear in real apps (labels, aria-label, aria-labelledby,
 * placeholder, alt, title, button text) and stops there. A complete
 * implementation would be thousands of lines for no additional matches.
 */
export const ROLE_AND_NAME = `
function __roleOf(el) {
  const explicit = el.getAttribute && el.getAttribute('role');
  if (explicit) return explicit.trim().toLowerCase();
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute && el.getAttribute('type') || '').toLowerCase();
  if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
  if (tag === 'button') return 'button';
  if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'img') return 'img';
  if (tag === 'table') return 'table';
  if (tag === 'tr') return 'row';
  if (tag === 'td' || tag === 'th') return 'cell';
  if (tag === 'form') return 'form';
  if (tag === 'nav') return 'navigation';
  if (tag === 'dialog') return 'dialog';
  if (tag === 'option') return 'option';
  if (/^h[1-6]$/.test(tag)) return 'heading';
  if (tag === 'input') {
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'search') return 'searchbox';
    if (type === 'number') return 'spinbutton';
    if (type === 'range') return 'slider';
    if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
    if (type === 'hidden') return 'generic';
    return 'textbox';
  }
  return 'generic';
}

function __collapse(s) { return (s || '').replace(/\\s+/g, ' ').trim(); }

function __accName(el) {
  if (!el || !el.getAttribute) return '';
  const aria = el.getAttribute('aria-label');
  if (aria && aria.trim()) return __collapse(aria);

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const parts = labelledBy.split(/\\s+/).map((id) => {
      const n = document.getElementById(id);
      return n ? n.textContent : '';
    });
    const joined = __collapse(parts.join(' '));
    if (joined) return joined;
  }

  if (el.id) {
    const lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
    if (lbl && __collapse(lbl.textContent)) return __collapse(lbl.textContent);
  }
  const wrapping = el.closest && el.closest('label');
  if (wrapping && __collapse(wrapping.textContent)) return __collapse(wrapping.textContent);

  const tag = el.tagName.toLowerCase();
  if (tag === 'img') {
    const alt = el.getAttribute('alt');
    if (alt !== null) return __collapse(alt);
  }
  if (tag === 'input') {
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'button' || type === 'submit' || type === 'reset') {
      if (el.value) return __collapse(el.value);
    }
    const ph = el.getAttribute('placeholder');
    if (ph && ph.trim()) return __collapse(ph);
  }

  const text = __collapse(el.textContent);
  if (text) return text;

  const title = el.getAttribute('title');
  return title ? __collapse(title) : '';
}
`;

/**
 * Occlusion hit-test and visibility.
 *
 * `receivesEvents` is the check that catches modal backdrops, cookie banners
 * and sticky headers eating a click. `elementsFromPoint` is used rather than
 * `elementFromPoint` so a `pointer-events:none` decorative overlay sitting on
 * top does not produce a false refusal.
 */
export const SAMPLE_FN = `
${DEEP_QUERY}
${ROLE_AND_NAME}
function __describe(el) {
  if (!el) return 'unknown';
  const tag = el.tagName ? el.tagName.toLowerCase() : '?';
  const id = el.id ? '#' + el.id : '';
  const cls = (typeof el.className === 'string' && el.className.trim())
    ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.')
    : '';
  return tag + id + cls;
}

/**
 * True only for an EXPLICIT zero opacity.
 *
 * \`Number('')\` is 0, so treating the raw value as a number classified an
 * unspecified opacity as fully transparent. Browsers always report a number here,
 * but "not specified" and "zero" are different claims and only one of them means
 * the element cannot be seen.
 */
function __isTransparent(style) {
  const op = parseFloat(style.opacity);
  return !isNaN(op) && op === 0;
}

/**
 * The element a user would actually click to operate \`el\`.
 *
 * Design systems routinely hide the native control and paint their own: the real
 * <input type="checkbox"> sits at opacity 0 with a styled <span> over it. Such a
 * control fails BOTH visibility (opacity 0) and the hit test (the span is on
 * top), so a strictly-correct actionability check refuses to click a checkbox
 * that every human clicks all day.
 *
 * The label is not a workaround for that — it IS the interaction surface. A click
 * on a label that owns a control is dispatched to the control by the browser, so
 * clicking it is what a real user does, not a simulation of it.
 *
 * Returns null when \`el\` needs no proxy, so ordinary controls keep sampling
 * themselves and nothing about their behaviour changes.
 */
function __proxyTarget(el) {
  const tag = el.tagName ? el.tagName.toLowerCase() : '';
  if (tag !== 'input' && tag !== 'select' && tag !== 'textarea') return null;

  const candidates = [];
  // \`labels\` covers <label for="id"> anywhere in the document.
  if (el.labels && el.labels.length) {
    for (const l of el.labels) candidates.push(l);
  }
  const wrapping = el.closest ? el.closest('label') : null;
  if (wrapping && candidates.indexOf(wrapping) === -1) candidates.push(wrapping);

  for (const c of candidates) {
    const cr = c.getBoundingClientRect();
    if (cr.width <= 0 || cr.height <= 0) continue;
    const cs = getComputedStyle(c);
    if (cs.display === 'none' || cs.visibility === 'hidden' || __isTransparent(cs)) continue;
    if (cs.pointerEvents === 'none') continue;
    return c;
  }
  return null;
}

function __hitTest(el, r) {
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const inViewport = cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight;
  if (!inViewport) return { receivesEvents: false, obscuredBy: 'outside viewport' };

  const stack = document.elementsFromPoint(cx, cy) || [];
  // Walk the stack top-down. Anything above the target that is not an
  // ancestor and not pointer-events:none is a genuine obscurer.
  for (const node of stack) {
    if (node === el || el.contains(node) || node.contains(el)) {
      return { receivesEvents: true, obscuredBy: undefined };
    }
    const ns = getComputedStyle(node);
    if (ns.pointerEvents === 'none') continue;
    return { receivesEvents: false, obscuredBy: __describe(node) };
  }
  // Nothing at the point at all — treat as obscured rather than clickable.
  return { receivesEvents: false, obscuredBy: 'nothing hit-testable at click point' };
}

function __sampleEl(el) {
  if (!el || !el.isConnected) {
    return { attached: false, visible: false, enabled: false, rect: null, receivesEvents: false };
  }
  const r = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const visible = r.width > 0 && r.height > 0 &&
    style.display !== 'none' && style.visibility !== 'hidden' && !__isTransparent(style);
  // Enabled state always comes from the CONTROL, never the proxy: a label is
  // never disabled, and reading it would report a disabled input as actionable.
  const enabled = !el.disabled && el.getAttribute('aria-disabled') !== 'true';

  let hit = visible ? __hitTest(el, r) : { receivesEvents: false, obscuredBy: undefined };
  let rect = r;
  let effVisible = visible;
  let proxiedBy = undefined;

  if (!visible || !hit.receivesEvents) {
    const proxy = __proxyTarget(el);
    if (proxy) {
      const pr = proxy.getBoundingClientRect();
      const ph = __hitTest(proxy, pr);
      if (ph.receivesEvents) {
        rect = pr;
        effVisible = true;
        hit = ph;
        proxiedBy = __describe(proxy);
      }
    }
  }

  return {
    attached: true,
    visible: effVisible,
    enabled: enabled,
    // The proxy's geometry, so the click is DISPATCHED on the label too.
    // Reporting the label as actionable while clicking the hidden input would
    // pass the checks and then miss.
    rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    receivesEvents: hit.receivesEvents,
    obscuredBy: hit.obscuredBy,
    proxiedBy: proxiedBy,
  };
}
`;

/**
 * Resolution across the three locator tiers.
 *
 * Returns the matched element's sample plus which tier matched, so the driver
 * can report heals (§5) without a second round trip. Elements are tagged with a
 * `data-pf-ref` attribute so subsequent calls address the exact same node
 * rather than re-running resolution and possibly picking a different match.
 */
export const RESOLVE_FN = `
${SAMPLE_FN}
let __pfRefSeq = (window.__pfRefSeq || 0);
function __tagRef(el) {
  let ref = el.getAttribute('data-pf-ref');
  if (!ref) {
    ref = 'pf' + (++__pfRefSeq);
    window.__pfRefSeq = __pfRefSeq;
    el.setAttribute('data-pf-ref', ref);
  }
  return ref;
}

function __byRef(ref) {
  return __deepQuery(document, '[data-pf-ref="' + ref + '"]');
}

function __matchSemantic(spec, scopeEl) {
  const root = scopeEl || document;
  const all = __deepQueryAll(root, '*', []);
  const wantRole = String(spec.role).toLowerCase();
  const wantName = String(spec.name);
  const exact = !!spec.exact;
  for (const el of all) {
    if (__roleOf(el) !== wantRole) continue;
    const name = __accName(el);
    if (exact ? name === wantName : name.indexOf(wantName) !== -1) return el;
  }
  return null;
}

function __resolveLocator(loc) {
  // Tier 1 — testid
  if (loc.testid) {
    const el = __deepQuery(document, '[data-testid="' + String(loc.testid).replace(/"/g, '\\\\"') + '"]');
    if (el) return { tier: 'testid', ref: __tagRef(el), sample: __sampleEl(el) };
  }
  // Tier 2 — semantic (role + accessible name, optionally scoped)
  if (loc.semantic) {
    let scopeEl = null;
    if (loc.semantic.scope) {
      const scoped = __resolveLocator(loc.semantic.scope);
      if (scoped) scopeEl = __byRef(scoped.ref);
      else return null;
    }
    const el = __matchSemantic(loc.semantic, scopeEl);
    if (el) return { tier: 'semantic', ref: __tagRef(el), sample: __sampleEl(el) };
  }
  // Tier 3 — structural CSS. Comma-separated fallbacks are tried in order.
  if (loc.structural && loc.structural.css) {
    const candidates = String(loc.structural.css).split(',').map((s) => s.trim()).filter(Boolean);
    for (const sel of candidates) {
      const el = __deepQuery(document, sel);
      if (el) return { tier: 'structural', ref: __tagRef(el), sample: __sampleEl(el), css: sel };
    }
  }
  return null;
}
`;

// ── Expression builders ─────────────────────────────────────────────────────

/** Resolve a locator, returning `{tier, ref, sample, css?}` or null. */
export function resolveExpr(locator: unknown): string {
  return `(() => { ${RESOLVE_FN} return __resolveLocator(${JSON.stringify(locator)}); })()`;
}

/** Re-sample an already-resolved element by its ref. */
export function sampleExpr(ref: string): string {
  return `(() => {
    ${SAMPLE_FN}
    const el = __deepQuery(document, '[data-pf-ref="${ref}"]');
    return __sampleEl(el);
  })()`;
}

/** Count matches for a locator across tiers, first tier that matches wins. */
export function countExpr(locator: unknown): string {
  return `(() => {
    ${RESOLVE_FN}
    const loc = ${JSON.stringify(locator)};
    if (loc.testid) {
      const n = __deepQueryAll(document, '[data-testid="' + loc.testid + '"]', []).length;
      if (n > 0) return n;
    }
    if (loc.semantic) {
      const all = __deepQueryAll(document, '*', []);
      const want = String(loc.semantic.role).toLowerCase();
      const name = String(loc.semantic.name);
      let n = 0;
      for (const el of all) {
        if (__roleOf(el) !== want) continue;
        const got = __accName(el);
        if (loc.semantic.exact ? got === name : got.indexOf(name) !== -1) n++;
      }
      if (n > 0) return n;
    }
    if (loc.structural && loc.structural.css) {
      for (const sel of String(loc.structural.css).split(',').map((s) => s.trim()).filter(Boolean)) {
        const n = __deepQueryAll(document, sel, []).length;
        if (n > 0) return n;
      }
    }
    return 0;
  })()`;
}

/** Scroll a resolved element into view, accounting for sticky headers. */
export function scrollIntoViewExpr(ref: string): string {
  return `(() => {
    ${DEEP_QUERY}
    const el = __deepQuery(document, '[data-pf-ref="${ref}"]');
    if (!el) return false;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    return true;
  })()`;
}

/**
 * Native-setter value assignment.
 *
 * React (and other frameworks with controlled inputs) tracks the previous value
 * on the DOM node; assigning `el.value` directly is silently reverted on the
 * next render. Going through the prototype's setter is what makes the change
 * stick and the synthetic `input` event fire the framework's handler.
 */
export function setValueExpr(ref: string, value: string): string {
  return `(() => {
    ${DEEP_QUERY}
    const el = __deepQuery(document, '[data-pf-ref="${ref}"]');
    if (!el) return false;
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, ${JSON.stringify(value)});
    else el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`;
}

export function focusExpr(ref: string): string {
  return `(() => {
    ${DEEP_QUERY}
    const el = __deepQuery(document, '[data-pf-ref="${ref}"]');
    if (!el) return false;
    el.focus();
    return document.activeElement === el;
  })()`;
}

export function readExpr(ref: string, what: 'text' | 'value' | 'attribute', attribute?: string): string {
  const read =
    what === 'text'
      ? 'String(el.textContent || "").replace(/\\s+/g, " ").trim()'
      : what === 'value'
        ? 'String(el.value !== undefined ? el.value : (el.textContent || ""))'
        : `el.getAttribute(${JSON.stringify(attribute ?? '')})`;
  return `(() => {
    ${DEEP_QUERY}
    const el = __deepQuery(document, '[data-pf-ref="${ref}"]');
    if (!el) return null;
    return ${read};
  })()`;
}

/** Set checkbox/radio state through the native setter, then fire events. */
export function setCheckedExpr(ref: string, checked: boolean): string {
  return `(() => {
    ${DEEP_QUERY}
    const el = __deepQuery(document, '[data-pf-ref="${ref}"]');
    if (!el) return null;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
    if (setter) setter.call(el, ${checked});
    else el.checked = ${checked};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.checked === ${checked};
  })()`;
}

/**
 * Native `<select>` option choice by value, then by visible label.
 * Returns null when the element is not a native select, so the driver can fall
 * through to custom-dropdown handling.
 */
export function selectNativeExpr(ref: string, value: string): string {
  return `(() => {
    ${DEEP_QUERY}
    const el = __deepQuery(document, '[data-pf-ref="${ref}"]');
    if (!el) return { ok: false, reason: 'not found' };
    if (el.tagName.toLowerCase() !== 'select') return null;
    const want = ${JSON.stringify(value)};
    let matched = -1;
    for (let i = 0; i < el.options.length; i++) {
      if (el.options[i].value === want) { matched = i; break; }
    }
    if (matched === -1) {
      for (let i = 0; i < el.options.length; i++) {
        const t = (el.options[i].textContent || '').replace(/\\s+/g, ' ').trim();
        if (t === want || t.indexOf(want) !== -1) { matched = i; break; }
      }
    }
    if (matched === -1) {
      const avail = Array.from(el.options).map((o) => o.value).slice(0, 10);
      return { ok: false, reason: 'no option matching "' + want + '" (have: ' + avail.join(', ') + ')' };
    }
    el.selectedIndex = matched;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  })()`;
}

/** Collapsed visible text of the document, capped. For snapshots. */
export function pageTextExpr(maxChars = 20_000): string {
  return `(() => {
    const t = document.body ? document.body.innerText : '';
    return String(t || '').replace(/\\s+/g, ' ').trim().slice(0, ${maxChars});
  })()`;
}
