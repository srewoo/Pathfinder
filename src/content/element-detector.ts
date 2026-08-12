import type { InteractiveElement, FormField } from '../storage/schemas';

import { walkDOM } from '../utils/dom-walker';

const INTERACTIVE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[role="button"]:not([disabled])',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[tabindex]:not([tabindex="-1"])',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="slider"]',
  '[contenteditable="true"]',
].join(',');

/**
 * Tags allowed to be a non-semantic clickable.
 *
 * `p`, `i`, `label`, `img` and headings were absent, and design systems use all of
 * them as controls — measured on a live app, "Forgot your password?" ships as
 * `<p class="oxd-text">` and is completely invisible without `p` here.
 */
const PSEUDO_TAGS = new Set([
  'div', 'span', 'li', 'td', 'p', 'label', 'i', 'img', 'svg',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);

/** Class fragments that mark an element as an icon. */
const ICON_CLASS_RX = /(^|[\s-])(icon|bi-|fa-|mdi-|material-icons|glyphicon|oxd-icon)/i;

function isIconLike(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === 'svg' || tag === 'i') return true;
  const cls = typeof el.className === 'string' ? el.className : '';
  return ICON_CLASS_RX.test(cls);
}

/**
 * Class tokens of any icons at or inside this element.
 *
 * Bounded to a handful — the point is to recognise `bi-trash`, not to inventory
 * a sprite sheet.
 */
export function iconClassesOf(el: Element): string[] {
  const out: string[] = [];
  const push = (node: Element): void => {
    const cls = typeof node.className === 'string' ? node.className : '';
    for (const token of cls.split(/\s+/)) {
      if (!token || out.length >= 8) continue;
      if (/^(bi|fa|fas|far|fal|fab|mdi|glyphicon|icon)-/.test(token) || /icon/i.test(token)) {
        if (!out.includes(token)) out.push(token);
      }
    }
  };
  if (isIconLike(el)) push(el);
  try {
    for (const child of el.querySelectorAll('i, svg, [class*="icon"]')) {
      if (out.length >= 8) break;
      push(child);
    }
  } catch { /* ignore */ }
  return out;
}

/**
 * True when a real interactive element already contains this one.
 *
 * Without this, an `<i class="bi-trash">` inside a `<button>` was captured as a
 * separate target, so the same control was clicked twice and the inventory was
 * inflated by one row per icon. Clicking the button already covers the icon.
 */
function hasInteractiveAncestor(el: Element): boolean {
  try {
    let p = el.parentElement;
    while (p && p !== document.body) {
      if (p.matches?.(INTERACTIVE_SELECTOR)) return true;
      p = p.parentElement;
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * Heuristic for "div-based buttons" — elements that act clickable but carry no
 * semantic role/tag (e.g. `<div onclick>` or a `cursor:pointer` widget). Bounded
 * to leaf-ish containers so it doesn't capture layout wrappers. Captured elements
 * are tagged with role="button" so they enter the click set.
 *
 * Accepts icon-only controls: the old rule required 1–60 characters of text, which
 * excluded every icon button by construction. An icon with a pointer cursor and no
 * text is a control; requiring words from it just made a whole category invisible.
 */
export function isPseudoClickable(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (!PSEUDO_TAGS.has(tag)) return false;
  // Skip containers — real clickable widgets are leaf-ish.
  if (el.childElementCount > 2) return false;
  const text = el.textContent?.trim() ?? '';
  if (text.length > 60) return false;
  // A text-free element only qualifies if something else marks it as a control:
  // an icon, an accessible name, or its own focusability.
  if (text.length === 0) {
    const named = !!(el.getAttribute('aria-label') || el.getAttribute('title'));
    const focusable = el.getAttribute('tabindex') !== null && el.getAttribute('tabindex') !== '-1';
    if (!isIconLike(el) && !named && !focusable) return false;
  }
  // Don't capture wrappers around a real interactive element, and don't capture
  // the innards of one either.
  try { if (el.querySelector(INTERACTIVE_SELECTOR)) return false; } catch { /* ignore */ }
  if (hasInteractiveAncestor(el)) return false;
  // Cheap signal first.
  if (el.hasAttribute('onclick')) return true;
  let cursor = '';
  try { cursor = getComputedStyle(el as HTMLElement).cursor; } catch { /* detached */ }
  return cursor === 'pointer';
}

/**
 * Rows that navigate when clicked, one representative target each.
 *
 * The pattern this exists for, measured on a live app's employee list: 50 rows,
 * every row `cursor: pointer`, **zero** `<a href>` anywhere in them. The
 * destination — each employee's record — is reachable only by clicking, and the
 * pointer cursor is inherited by all 9 cells, so a naive reading saw 450 targets
 * that were really 50.
 *
 * Returning one cell per row is the difference between discovering a detail page
 * and navigating to the same template nine times per row.
 */
const ROW_SELECTOR = 'tr, [role="row"]';
const CELL_SELECTOR = 'td, th, [role="cell"], [role="gridcell"], [role="columnheader"]';
/**
 * Bound on candidates, not on rows. A grid can hold thousands of rows and they
 * are homogeneous; the cap that matters for behaviour is applied by the caller,
 * this one only keeps the inventory from ballooning.
 */
const MAX_ROW_NAV_CANDIDATES = 25;

export function detectRowNavigationTargets(): InteractiveElement[] {
  const out: InteractiveElement[] = [];
  let rows: Element[];
  try {
    rows = [...document.querySelectorAll(ROW_SELECTOR)];
  } catch {
    return out;
  }

  for (const row of rows) {
    if (out.length >= MAX_ROW_NAV_CANDIDATES) break;
    // A header row sorts when clicked; that is a different interaction, and it is
    // already reachable as an ordinary control.
    if (row.querySelector('th, [role="columnheader"]')) continue;

    let pointer = false;
    try {
      pointer = getComputedStyle(row as HTMLElement).cursor === 'pointer';
    } catch { continue; }
    if (!pointer) continue;

    // The cell to click: has its own text, and holds no control of its own — so
    // the click cannot land on a checkbox or a row action instead.
    let target: Element | null = null;
    for (const cell of row.querySelectorAll(CELL_SELECTOR)) {
      const text = cell.textContent?.trim() ?? '';
      if (text.length === 0 || text.length > 80) continue;
      try {
        if (cell.querySelector(INTERACTIVE_SELECTOR)) continue;
      } catch { continue; }
      target = cell;
      break;
    }
    if (!target) continue;

    try {
      const rect = target.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      out.push({
        selector: generateSelector(target),
        tag: target.tagName.toLowerCase(),
        text: target.textContent?.trim().slice(0, 100) ?? undefined,
        // Synthesised so it enters the click set, exactly as pseudo-clickables are.
        role: 'button',
        rowNavigation: true,
        inDataRegion: true,
        visible: rect.top < window.innerHeight && rect.bottom > 0,
        position: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      });
    } catch { /* detached mid-walk */ }
  }
  return out;
}

/** Table/grid/list containers — see `InteractiveElement.inDataRegion`. */
const DATA_REGION_SELECTOR =
  'table, tbody, [role="grid"], [role="table"], [role="rowgroup"], [role="row"], [role="list"], ul, ol';

function inDataRegion(el: Element): boolean {
  try {
    return el.closest?.(DATA_REGION_SELECTOR) !== null;
  } catch {
    return false;
  }
}

export function detectInteractiveElements(): InteractiveElement[] {
  const elements: InteractiveElement[] = [];
  const seen = new Set<string>();

  // Cap raised from 300 → 1500 so dashboards/grids with many widgets get
  // captured. Walker is iterative and de-duped; cost stays linear.
  const ELEMENT_CAP = 1500;

  walkDOM(document.body, (el) => {
    if (elements.length >= ELEMENT_CAP) return false;

    // Match either a semantic interactive element OR a div-based clickable widget.
    let pseudoClickable = false;
    try {
      if (!el.matches || !el.matches(INTERACTIVE_SELECTOR)) {
        if (!isPseudoClickable(el)) return true; // continue to children
        pseudoClickable = true;
      }
    } catch {
      return true; // matches() can throw on detached elements
    }

    try {
      const cssSelector = generateSelector(el);
      if (seen.has(cssSelector)) return true;
      seen.add(cssSelector);

      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      // Strict visibility = in viewport AND rendered. Off-viewport elements
      // (virtualized list rows that are mounted but scrolled out, sticky
      // footers below the fold) are still kept in the inventory so callers
      // can scroll-into-view before clicking — they just won't be ranked as
      // top candidates.
      const inDocument = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      const inViewport = inDocument && rect.top < window.innerHeight && rect.bottom > 0;
      const visible = inViewport;
      if (!inDocument) return true;

      const iconClasses = iconClassesOf(el);
      const tabIndexAttr = el.getAttribute('tabindex');
      const testId = el.getAttribute('data-testid') ?? el.getAttribute('data-test-id') ?? undefined;
      const name = el.getAttribute('name') ?? undefined;
      const isDisabled = (el as HTMLButtonElement).disabled ?? false;
      const isContentEditable = el.getAttribute('contenteditable') === 'true';

      const rawClasses = el.className;
      const stableClasses = typeof rawClasses === 'string'
        ? rawClasses.split(/\s+/).filter((cls) => cls.length > 1 && !isUtilityClass(cls)).slice(0, 5)
        : [];

      elements.push({
        selector: cssSelector,
        tag: el.tagName.toLowerCase(),
        type: (el as HTMLInputElement).type ?? undefined,
        text: el.textContent?.trim().slice(0, 100) ?? undefined,
        ariaLabel: el.getAttribute('aria-label') ?? undefined,
        // Synthesise role="button" for div-based clickables so they're treated
        // as clickable targets downstream.
        role: el.getAttribute('role') ?? (pseudoClickable ? 'button' : undefined),
        classes: stableClasses.length > 0 ? stableClasses : undefined,
        testId: testId || undefined,
        disabled: isDisabled || undefined,
        name: name || undefined,
        contentEditable: isContentEditable || undefined,
        inDataRegion: inDataRegion(el) || undefined,
        // `.href` (not getAttribute) so it is absolute — a relative "logout"
        // would otherwise slip past a URL check anchored on path separators.
        href: el instanceof HTMLAnchorElement ? el.href || undefined : undefined,
        iconClasses: iconClasses.length > 0 ? iconClasses : undefined,
        tabIndex: tabIndexAttr === null ? undefined : Number(tabIndexAttr),
        visible,
        position: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      });
    } catch {
      // Ignore
    }
    return true;
  });

  // Row-navigation targets last, deduped against the walk. A row cell is not
  // interactive by any DOM signal the walk understands, so it has to be derived
  // structurally — but if the walk already captured it, that entry wins.
  for (const rowTarget of detectRowNavigationTargets()) {
    if (elements.length >= ELEMENT_CAP) break;
    if (seen.has(rowTarget.selector)) continue;
    seen.add(rowTarget.selector);
    elements.push(rowTarget);
  }

  return elements;
}

/**
 * Extract all same-origin `<a href>` links from the current page.
 * This is the most reliable way to discover pages in an SPA or multi-page site
 * because it reads directly from the DOM without needing to click anything.
 *
 * Filters out: external domains, mailto/tel/javascript links, same-page anchors,
 * and duplicate normalized URLs.
 */
export interface DiscoveredLink {
  url: string;
  text: string;
}

export function extractSameOriginLinks(origin: string): DiscoveredLink[] {
  const seen = new Set<string>();
  const links: DiscoveredLink[] = [];

  document.querySelectorAll('a[href]').forEach((a) => {
    const anchor = a as HTMLAnchorElement;
    const href = anchor.href;
    if (!href) return;
    try {
      const parsed = new URL(href);
      if (parsed.origin !== origin) return;
      if (!parsed.protocol.startsWith('http')) return;
      // Skip pure fragment links on the same page
      if (parsed.pathname === window.location.pathname && parsed.hash && !parsed.search) return;
      // Normalize: remove trailing slash and hash (hash-routing SPAs handled by pathname)
      const normalized = parsed.origin + parsed.pathname.replace(/\/$/, '') + (parsed.search || '');
      if (!seen.has(normalized)) {
        seen.add(normalized);
        // Extract the visible text of the link: prefer innerText (visible only),
        // then aria-label, then title attribute, then fall back to "Link".
        const visibleText = anchor.innerText?.trim().replace(/\s+/g, ' ').slice(0, 100);
        const ariaLabel = anchor.getAttribute('aria-label')?.trim();
        const titleAttr = anchor.getAttribute('title')?.trim();
        const text = visibleText || ariaLabel || titleAttr || 'Link';
        links.push({ url: normalized, text });
      }
    } catch {
      // skip invalid hrefs
    }
  });

  return links;
}

/**
 * Hover navigation to open menus, then sweep the page to mount lazy content,
 * scanning at every step and returning the UNION of everything seen.
 *
 * Returning the union is the fix for virtualized lists. A `react-window` grid
 * mounts only the rows in its viewport, so a single scan after the sweep sees one
 * window of rows — and which window depended on where the sweep happened to stop.
 * On a 4,000-row grid that meant the caller mapped an arbitrary slice and had no
 * way to know it. Scanning per step captures each window as it mounts.
 *
 * Elements here may be unmounted again by the time a caller clicks them. That is
 * expected and handled: the click path reports the element as gone rather than
 * failing the run.
 */
export async function revealPageContent(): Promise<InteractiveElement[]> {
  // Union of everything seen across the sweep, keyed by selector.
  const union = new Map<string, InteractiveElement>();
  /** Bounded for the same reason the single-pass scan is bounded. */
  const UNION_CAP = 3000;

  const collect = (): void => {
    if (union.size >= UNION_CAP) return;
    for (const el of detectInteractiveElements()) {
      if (union.size >= UNION_CAP) break;
      const prior = union.get(el.selector);
      // Prefer the sighting where the element was in the viewport — it carries
      // the truthful geometry, and ranking uses `visible` to order candidates.
      if (!prior || (!prior.visible && el.visible)) union.set(el.selector, el);
    }
  };

  // 1. Hover nav items + any element with aria-haspopup / aria-expanded so
  //    dropdown menus, command palettes, and submenus open before scanning.
  const HOVER_SELECTORS = [
    'nav > *', 'nav li',
    '[role="navigation"] > *',
    '[role="menubar"] > [role="menuitem"]',
    'header nav > *', 'header li',
    '.nav > li', '#nav > li',
    '[data-testid*="nav"] > *',
    '[aria-haspopup="true"]', '[aria-haspopup="menu"]', '[aria-haspopup="listbox"]',
    '[aria-expanded="false"]',
  ];

  /** Everything hovered, so the sweep can put it back. */
  const hovered: HTMLElement[] = [];
  const dispatchHover = (htmlEl: HTMLElement) => {
    const init: MouseEventInit = { bubbles: true, cancelable: true };
    if (!hovered.includes(htmlEl)) hovered.push(htmlEl);
    htmlEl.dispatchEvent(new PointerEvent('pointerover', init));
    htmlEl.dispatchEvent(new MouseEvent('mouseover', init));
    htmlEl.dispatchEvent(new MouseEvent('mouseenter', { ...init, bubbles: false }));
    htmlEl.dispatchEvent(new MouseEvent('mousemove', init));
  };

  for (const sel of HOVER_SELECTORS) {
    try {
      document.querySelectorAll(sel).forEach((el) => {
        const htmlEl = el as HTMLElement;
        if (!htmlEl.offsetParent) return; // skip hidden
        dispatchHover(htmlEl);
      });
    } catch { /* skip invalid selectors */ }
  }

  // Wait for dropdown animations / data fetches
  await new Promise((r) => setTimeout(r, 400));
  collect(); // menus are open now and close again as soon as focus moves

  // 2. Multi-pass scroll, scanning at every step. Virtualized lists
  //    (react-window, ag-grid) mount only the rows currently in view, so each
  //    step reveals a different set — `collect` is what keeps them all.
  await deepScroll(collect);

  // 3. Re-hover after scroll — sticky toolbars and contextual menus often
  //    only appear once their parent is in view.
  for (const sel of HOVER_SELECTORS) {
    try {
      document.querySelectorAll(sel).forEach((el) => {
        const htmlEl = el as HTMLElement;
        if (!htmlEl.offsetParent) return;
        dispatchHover(htmlEl);
      });
    } catch { /* skip */ }
  }
  await new Promise((r) => setTimeout(r, 200));
  collect();

  // 4. Leave the page as we found it: top of the window AND top of every inner
  //    scroll container. Restoring only the window was a real defect — a
  //    virtualized grid left scrolled to its end had the first rows unmounted,
  //    so the caller's own scan saw the tail of the list while the user was
  //    looking at the head of it.
  window.scrollTo({ top: 0, behavior: 'instant' });
  for (const c of findScrollContainers()) c.scrollTop = 0;
  await new Promise((r) => setTimeout(r, 200));
  collect();

  // 5. Close what the hovering opened. The sweep opens every nav dropdown and
  //    every `aria-expanded="false"` control to see inside them, and it used to
  //    leave them all open — a stack of flyouts covering the page for the rest of
  //    the run. Everything underneath then failed its hit test as "obscured", so
  //    the caller spent a click timeout per element and clicked the menu instead
  //    of the control it aimed at.
  //
  //    Done AFTER the final collect: the menu contents are already captured, so
  //    closing costs no coverage.
  await closeOpenedOverlays(hovered);

  return [...union.values()];
}

/**
 * Undo the sweep's hovering.
 *
 * Three escalating steps, each safe on a page that has nothing open:
 *   1. un-hover exactly what was hovered (the inverse of what opened them)
 *   2. Escape, which closes most menus, popovers and comboboxes
 *   3. a click on a point that hit-tests to `<body>` — an outside click on
 *      nothing, for menus that only close that way
 *
 * Step 3 dispatches at coordinates over empty space and only when a point can be
 * found whose topmost element IS the body or html. Clicking blind to dismiss a
 * menu could hit any control on the page.
 */
async function closeOpenedOverlays(hovered: readonly HTMLElement[]): Promise<void> {
  const init: MouseEventInit = { bubbles: true, cancelable: true };
  for (const el of hovered) {
    try {
      el.dispatchEvent(new PointerEvent('pointerout', init));
      el.dispatchEvent(new MouseEvent('mouseout', init));
      el.dispatchEvent(new MouseEvent('mouseleave', { ...init, bubbles: false }));
    } catch { /* detached */ }
  }

  try {
    const active = (document.activeElement as HTMLElement | null) ?? document.body;
    for (const target of new Set([active, document.body])) {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
      target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));
    }
    (document.activeElement as HTMLElement | null)?.blur?.();
  } catch { /* ignore */ }

  await new Promise((r) => setTimeout(r, 150));
  if (hasOpenOverlay()) {
    const spot = findEmptyPoint();
    if (spot) {
      const target = document.elementFromPoint(spot.x, spot.y) ?? document.body;
      const opts = { bubbles: true, cancelable: true, clientX: spot.x, clientY: spot.y };
      try {
        target.dispatchEvent(new PointerEvent('pointerdown', opts));
        target.dispatchEvent(new MouseEvent('mousedown', opts));
        target.dispatchEvent(new MouseEvent('mouseup', opts));
        target.dispatchEvent(new MouseEvent('click', opts));
      } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

/** Menus/popovers still on screen after the un-hover. */
const OVERLAY_SELECTOR = '[role="menu"], [role="listbox"], [role="tooltip"], [aria-expanded="true"]';

function hasOpenOverlay(): boolean {
  try {
    for (const el of document.querySelectorAll(OVERLAY_SELECTOR)) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      // Geometry alone is not enough: a hidden menu can still report a box, and
      // treating it as open would dispatch an outside-click on a page with nothing
      // open at all.
      const st = getComputedStyle(el as HTMLElement);
      if (st.display === 'none' || st.visibility === 'hidden') continue;
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * A viewport point whose topmost element is the document body itself.
 *
 * Probes the edges, where page chrome is least likely to sit. Returns null when
 * every candidate lands on some element — in which case no click is dispatched,
 * because dismissing a menu is not worth pressing an unknown control.
 */
function findEmptyPoint(): { x: number; y: number } | null {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const candidates = [
    { x: w - 4, y: Math.round(h / 2) },
    { x: w - 4, y: h - 4 },
    { x: Math.round(w / 2), y: h - 4 },
    { x: 4, y: h - 4 },
    { x: w - 4, y: 4 },
  ];
  for (const p of candidates) {
    try {
      const el = document.elementFromPoint(p.x, p.y);
      if (!el || el === document.body || el === document.documentElement) return p;
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * Inner scroll containers — modals, side panes, ag-grid bodies — which often
 * hold the real list. Heuristic: taller than 200px and actually scrollable.
 */
function findScrollContainers(): HTMLElement[] {
  const containers: HTMLElement[] = [];
  document.querySelectorAll('*').forEach((el) => {
    if (containers.length >= 8) return;
    const h = el as HTMLElement;
    if (!h.offsetParent) return;
    const cs = getComputedStyle(h);
    const overflow = cs.overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && h.scrollHeight > h.clientHeight + 50 && h.clientHeight > 200) {
      containers.push(h);
    }
  });
  return containers;
}

/**
 * Step through the page (and any internal scroll containers) in 8 increments to
 * trigger lazy-loading and mount virtualized rows, calling `onStep` after each
 * one so the caller can capture what is mounted RIGHT NOW.
 */
async function deepScroll(onStep: () => void): Promise<void> {
  const pageHeight = document.documentElement.scrollHeight;
  const steps = [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1.0];
  const scrollContainers = findScrollContainers();

  for (const pct of steps) {
    window.scrollTo({ top: pageHeight * pct, behavior: 'instant' });
    for (const c of scrollContainers) {
      c.scrollTop = (c.scrollHeight - c.clientHeight) * pct;
    }
    await new Promise((r) => setTimeout(r, 250));
    onStep();
  }
}

/**
 * Detect all form fields on the current page and capture their constraints.
 * This data is used to generate grounded negative/edge-case tests.
 */
export function detectFormFields(): FormField[] {
  const fields: FormField[] = [];
  const FIELD_SELECTOR =
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]):not([type="reset"]), select, textarea';

  // Gather fields via walkDOM (pierces open shadow roots + same-origin iframes)
  // rather than document.querySelectorAll, which stops at the top document and
  // misses form controls inside web components — common in design-system UIs.
  const fieldEls: Element[] = [];
  const seenFieldEls = new Set<Element>();
  walkDOM(document.body, (el) => {
    try {
      if (el.matches?.(FIELD_SELECTOR) && !seenFieldEls.has(el)) {
        seenFieldEls.add(el);
        fieldEls.push(el);
      }
    } catch { /* matches() can throw on detached nodes */ }
  });

  fieldEls.forEach((el) => {
    try {
      const selector = generateSelector(el);
      const tag = el.tagName.toLowerCase();
      const input = el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

      // Resolve label text via multiple strategies
      let label = '';
      if (input.id) {
        const forLabel = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
        if (forLabel) label = forLabel.textContent?.trim() ?? '';
      }
      if (!label) {
        const parentLabel = el.closest('label');
        if (parentLabel) {
          // Remove the input's own value from the label text
          label = (parentLabel.textContent ?? '').replace((input as HTMLInputElement).value ?? '', '').trim();
        }
      }
      if (!label) label = el.getAttribute('aria-label') ?? '';
      if (!label) {
        const labelledById = el.getAttribute('aria-labelledby');
        if (labelledById) {
          const labelEl = document.getElementById(labelledById);
          if (labelEl) label = labelEl.textContent?.trim() ?? '';
        }
      }
      if (!label) label = el.getAttribute('placeholder') ?? '';

      const field: FormField = {
        selector,
        label: label.slice(0, 100) || undefined,
        type: tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : (input as HTMLInputElement).type || 'text',
        name: input.name || undefined,
        placeholder: (input as HTMLInputElement).placeholder || undefined,
        required: input.required,
      };

      if (tag === 'input') {
        const inp = input as HTMLInputElement;
        if (inp.minLength > 0) field.minLength = inp.minLength;
        if (inp.maxLength > 0 && inp.maxLength < 524288) field.maxLength = inp.maxLength;
        if (inp.min) field.min = inp.min;
        if (inp.max) field.max = inp.max;
        if (inp.pattern) field.pattern = inp.pattern;
      } else if (tag === 'textarea') {
        const ta = input as HTMLTextAreaElement;
        if (ta.minLength > 0) field.minLength = ta.minLength;
        if (ta.maxLength > 0 && ta.maxLength < 524288) field.maxLength = ta.maxLength;
      } else if (tag === 'select') {
        field.options = Array.from((input as HTMLSelectElement).options)
          .filter((o) => o.value !== '')
          .map((o) => o.text.trim())
          .slice(0, 20);
      }

      fields.push(field);
    } catch {
      // Skip elements that throw during inspection
    }
  });

  return fields;
}

export function generateSelector(el: Element): string {
  // 1. ID — most stable
  if (el.id) return `#${CSS.escape(el.id)}`;

  const tag = el.tagName.toLowerCase();

  // 2. Common test-ID attributes (data-testid, data-test-id, data-test, data-cy, data-qa, data-automation-id)
  const TEST_ID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa', 'data-automation-id'];
  for (const attr of TEST_ID_ATTRS) {
    const val = el.getAttribute(attr);
    if (val) return `[${attr}="${CSS.escape(val)}"]`;
  }

  // 3. aria-label
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return `${tag}[aria-label="${CSS.escape(ariaLabel)}"]`;

  // 4. Form field name attribute
  const name = el.getAttribute('name');
  if (name && (tag === 'input' || tag === 'select' || tag === 'textarea')) {
    return `${tag}[name="${CSS.escape(name)}"]`;
  }

  // 5. Role + unique identifying attribute
  const role = el.getAttribute('role');
  if (role) {
    const title = el.getAttribute('title');
    if (title) return `[role="${role}"][title="${CSS.escape(title)}"]`;
  }

  // 6. For buttons/links, try type attribute
  if (tag === 'button') {
    const type = el.getAttribute('type');
    if (type === 'submit') return 'button[type="submit"]';
  }
  if (tag === 'input') {
    const type = (el as HTMLInputElement).type;
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return `input[type="${type}"][placeholder="${CSS.escape(placeholder)}"]`;
  }

  // 7. Unique semantic class (not utility) — only if it uniquely identifies the element
  const stableClass = findUniqueStableClass(el, tag);
  if (stableClass) return stableClass;

  // 8. For links, try href-based selector if href is short and meaningful
  if (tag === 'a') {
    const href = el.getAttribute('href');
    if (href && href.length < 80 && !href.startsWith('javascript:')) {
      return `a[href="${CSS.escape(href)}"]`;
    }
  }

  // 9. Placeholder as last non-positional strategy
  const placeholder = el.getAttribute('placeholder');
  if (placeholder) return `${tag}[placeholder="${CSS.escape(placeholder)}"]`;

  // 10. title attribute
  const title = el.getAttribute('title');
  if (title) return `${tag}[title="${CSS.escape(title)}"]`;

  // 11. Last resort — positional CSS path, but with improved algorithm
  return buildCssPath(el);
}

/**
 * Try to find a unique, stable CSS class selector for this element.
 * Returns null if no unique class-based selector can be found.
 */
function findUniqueStableClass(el: Element, tag: string): string | null {
  const rawClasses = el.className;
  if (typeof rawClasses !== 'string') return null;

  const classes = rawClasses.split(/\s+/).filter((cls) => cls.length > 1 && !isUtilityClass(cls));

  for (const cls of classes) {
    const selector = `${tag}.${CSS.escape(cls)}`;
    try {
      if (document.querySelectorAll(selector).length === 1) return selector;
    } catch {
      // skip
    }
  }

  // Try class-only (no tag) for more specificity
  for (const cls of classes) {
    const selector = `.${CSS.escape(cls)}`;
    try {
      if (document.querySelectorAll(selector).length === 1) return selector;
    } catch {
      // skip
    }
  }

  return null;
}

function buildCssPath(el: Element): string {
  const parts: string[] = [];
  let current: Element | null = el;

  while (current && current !== document.body && parts.length < 5) {
    const tag = current.tagName.toLowerCase();

    // Skip generic wrapper divs/spans — they produce noisy `div > div > div` chains
    if ((tag === 'div' || tag === 'span') && parts.length > 0) {
      // Try to use an attribute anchor on this wrapper instead
      const anchor = getAnchorForElement(current);
      if (anchor) {
        parts.unshift(anchor);
        break; // We have a good anchor, stop climbing
      }
      // Skip to parent if this div/span has no distinguishing attributes
      current = current.parentElement;
      continue;
    }

    const parent: Element | null = current.parentElement;
    if (!parent) break;

    // If the element has an identifying attribute, use it and stop climbing
    const anchor = getAnchorForElement(current);
    if (anchor) {
      parts.unshift(anchor);
      break;
    }

    const currentEl = current;
    const siblings = Array.from<Element>(parent.children).filter(
      (s) => s.tagName === currentEl.tagName
    );

    if (siblings.length > 1) {
      const index = siblings.indexOf(currentEl) + 1;
      parts.unshift(`${tag}:nth-of-type(${index})`);
    } else {
      parts.unshift(tag);
    }

    current = parent;
  }

  return parts.join(' > ') || el.tagName.toLowerCase();
}

/**
 * Get a stable attribute-based selector fragment for an element.
 * Used to anchor positional paths at a meaningful point instead of bare tags.
 */
function getAnchorForElement(el: Element): string | null {
  if (el.id) return `#${CSS.escape(el.id)}`;

  const TEST_ID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa', 'data-automation-id'];
  for (const attr of TEST_ID_ATTRS) {
    const val = el.getAttribute(attr);
    if (val) return `[${attr}="${CSS.escape(val)}"]`;
  }

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(ariaLabel)}"]`;

  const role = el.getAttribute('role');
  if (role && role !== 'presentation' && role !== 'none') {
    return `[role="${role}"]`;
  }

  const name = el.getAttribute('name');
  const tag = el.tagName.toLowerCase();
  if (name && (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'form')) {
    return `${tag}[name="${CSS.escape(name)}"]`;
  }

  // Stable class
  const rawClasses = el.className;
  if (typeof rawClasses === 'string') {
    const stableClasses = rawClasses.split(/\s+/).filter((cls) => cls.length > 1 && !isUtilityClass(cls));
    if (stableClasses.length > 0) {
      const cls = stableClasses[0];
      return `${tag}.${CSS.escape(cls)}`;
    }
  }

  return null;
}

function isUtilityClass(cls: string): boolean {
  return /^(p[xytblr]?-|m[xytblr]?-|w-|h-|min-|max-|flex|grid|gap-|text-|bg-|border|rounded|shadow|overflow|z-|opacity-|transition|duration-|ease-|transform|scale-|rotate-|translate-|sr-only|hover:|focus:|active:|dark:|sm:|md:|lg:|xl:|2xl:|-?[0-9])/.test(cls);
}
