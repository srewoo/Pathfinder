import type { InteractiveElement, FormField } from '../storage/schemas';

import { walkDOM } from '../utils/dom-walker';

export function detectInteractiveElements(): InteractiveElement[] {
  const elements: InteractiveElement[] = [];
  const seen = new Set<string>();
  
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

  // Cap raised from 300 → 1500 so dashboards/grids with many widgets get
  // captured. Walker is iterative and de-duped; cost stays linear.
  const ELEMENT_CAP = 1500;

  walkDOM(document.body, (el) => {
    if (elements.length >= ELEMENT_CAP) return false;

    // Skip matching check for elements inside shadow roots — matches() works differently
    try {
      if (!el.matches || !el.matches(INTERACTIVE_SELECTOR)) {
        return true; // continue to children
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

      const testId = el.getAttribute('data-testid') ?? el.getAttribute('data-test-id') ?? undefined;
      const name = el.getAttribute('name') ?? undefined;
      const isDisabled = (el as HTMLButtonElement).disabled ?? false;
      const isContentEditable = el.getAttribute('contenteditable') === 'true';

      const rawClasses = el.className;
      const stableClasses = typeof rawClasses === 'string'
        ? rawClasses.split(/\\s+/).filter((cls) => cls.length > 1 && !isUtilityClass(cls)).slice(0, 5)
        : [];

      elements.push({
        selector: cssSelector,
        tag: el.tagName.toLowerCase(),
        type: (el as HTMLInputElement).type ?? undefined,
        text: el.textContent?.trim().slice(0, 100) ?? undefined,
        ariaLabel: el.getAttribute('aria-label') ?? undefined,
        role: el.getAttribute('role') ?? undefined,
        classes: stableClasses.length > 0 ? stableClasses : undefined,
        testId: testId || undefined,
        disabled: isDisabled || undefined,
        name: name || undefined,
        contentEditable: isContentEditable || undefined,
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
 * Hover over navigation elements to open dropdown menus, revealing hidden links.
 * Then scroll through the page to trigger lazy-loaded content.
 * Finally scroll back to top so element scanning starts from the top.
 */
export async function revealPageContent(): Promise<void> {
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

  const dispatchHover = (htmlEl: HTMLElement) => {
    const init: MouseEventInit = { bubbles: true, cancelable: true };
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

  // 2. Multi-pass scroll. Virtualized lists (react-window, ag-grid) only
  //    mount the rows currently in the viewport, so we step through the page
  //    in fine increments and let the scanner peek between each step.
  //    Also scroll any internal scroll containers (overflow:auto/scroll).
  await deepScroll();

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

  // 4. Return to top so scanning starts from the natural reading order.
  window.scrollTo({ top: 0, behavior: 'instant' });
  await new Promise((r) => setTimeout(r, 200));
}

/**
 * Step through the page (and any internal scroll containers) in 8 increments
 * to trigger lazy-loading and mount virtualized list rows.
 */
async function deepScroll(): Promise<void> {
  const pageHeight = document.documentElement.scrollHeight;
  const steps = [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1.0];

  // Find inner scroll containers — they often hold the real list (modals,
  // side panes, ag-grid bodies). Heuristic: bigger than 200px and scrollable.
  const scrollContainers: HTMLElement[] = [];
  document.querySelectorAll('*').forEach((el) => {
    if (scrollContainers.length >= 8) return;
    const h = el as HTMLElement;
    if (!h.offsetParent) return;
    const cs = getComputedStyle(h);
    const overflow = cs.overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && h.scrollHeight > h.clientHeight + 50 && h.clientHeight > 200) {
      scrollContainers.push(h);
    }
  });

  for (const pct of steps) {
    window.scrollTo({ top: pageHeight * pct, behavior: 'instant' });
    for (const c of scrollContainers) {
      c.scrollTop = (c.scrollHeight - c.clientHeight) * pct;
    }
    await new Promise((r) => setTimeout(r, 250));
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

  document.querySelectorAll(FIELD_SELECTOR).forEach((el) => {
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
