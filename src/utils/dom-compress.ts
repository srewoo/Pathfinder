import { walkDOM } from './dom-walker';

const MAX_COMPRESSED_LENGTH = 20000;

export interface CompressedDOM {
  url: string;
  title: string;
  interactiveElements: string;
  visibleText: string;
  truncated: boolean;
}

export function compressDOM(document: Document): CompressedDOM {
  const url = document.location?.href ?? '';
  const title = document.title ?? '';

  const interactiveElements: string[] = [];
  let visibleText = '';
  let truncated = false;

  const seenIds = new Set<string>();

  const INTERACTIVE_SELECTORS = [
    'button',
    'a[href]',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="tab"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="combobox"]',
    '[role="listbox"]',
    '[role="slider"]',
    '[onclick]',
    '[tabindex]:not([tabindex="-1"])',
    '[contenteditable="true"]',
  ].join(',');

  const IGNORE_TAGS = new Set(['SCRIPT', 'STYLE', 'SVG', 'NOSCRIPT', 'TEMPLATE', 'META', 'HEAD']);

  if (document.body) {
    walkDOM(document.body, (el) => {
      const tag = el.tagName.toUpperCase();

      // Skip invisible/irrelevant trees
      if (IGNORE_TAGS.has(tag)) return false;

      let isVisible = true;
      try {
        if (typeof window !== 'undefined' && window.getComputedStyle) {
          const style = window.getComputedStyle(el as HTMLElement);
          if (style.display === 'none' || style.visibility === 'hidden') isVisible = false;
        }
      } catch {
        // Safe fallback for detached DOMParser nodes
      }
      if (!isVisible) return false;

      // Check if interactive
      if (el.matches && el.matches(INTERACTIVE_SELECTORS)) {
        if (interactiveElements.length < 300) {
          const id = el.id ? `#${el.id}` : '';
          
          if (!(id && seenIds.has(id))) {
            if (id) seenIds.add(id);

            const text = (el.textContent ?? '').trim().slice(0, 80);
            const ariaLabel = el.getAttribute('aria-label') ?? '';
            const type = el.getAttribute('type') ?? '';
            const placeholder = el.getAttribute('placeholder') ?? '';
            const name = el.getAttribute('name') ?? '';
            const role = el.getAttribute('role') ?? '';
            const testId = el.getAttribute('data-testid') ?? el.getAttribute('data-test-id') ?? '';
            const disabled = (el as HTMLButtonElement).disabled ? 'disabled' : '';
            const classes = filterStableClasses(el.className);

            const desc = [
              tag.toLowerCase(), id, type, name, role, testId, ariaLabel || text, placeholder, disabled, classes
            ].filter(Boolean).join(' | ');

            interactiveElements.push(desc);
          }
        }
      }

      // Collect visible text directly without cloneNode
      // Only process text nodes that are direct children of this element
      if (visibleText.length < MAX_COMPRESSED_LENGTH) {
        let child = el.firstChild;
        while (child) {
          if (child.nodeType === Node.TEXT_NODE) {
            const text = child.textContent?.trim();
            if (text) {
              visibleText += text + ' ';
            }
          }
          child = child.nextSibling;
        }
      } else {
        truncated = true;
      }

      return true; // continue traversing children
    });
  }

  // Normalize visible text spacing
  visibleText = visibleText.replace(/\s+/g, ' ').trim();

  return {
    url,
    title,
    interactiveElements: interactiveElements.join('\n'),
    visibleText: visibleText.slice(0, Math.floor(MAX_COMPRESSED_LENGTH * 0.25)),
    truncated,
  };
}

/** Filter CSS classes to keep only stable, semantic ones (skip Tailwind/utility noise) */
function filterStableClasses(className: string | SVGAnimatedString): string {
  if (!className || typeof className !== 'string') return '';
  const UTILITY_PATTERN = /^(p[xytblr]?|m[xytblr]?|w-|h-|min-|max-|flex|grid|gap|text-|bg-|border|rounded|shadow|overflow|z-|opacity|transition|duration|ease|transform|scale|rotate|translate|sr-only|hover:|focus:|active:|dark:|sm:|md:|lg:|xl:|2xl:|-?[0-9])/;
  const stable = className
    .split(/\s+/)
    .filter((cls) => cls.length > 1 && !UTILITY_PATTERN.test(cls))
    .slice(0, 5);
  return stable.length > 0 ? `.${stable.join('.')}` : '';
}

export function compressDOMString(html: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  // For strings, window.getComputedStyle throws, so this environment needs mocking if used in Node.
  // Fortunately Pathfinder runs in browser where DOMParser creates proper objects, but we must protect window access
  return JSON.stringify(compressDOM(doc), null, 2);
}

export function serializeCompressedDOM(compressed: CompressedDOM): string {
  return `URL: ${compressed.url}
Title: ${compressed.title}

Interactive Elements:
${compressed.interactiveElements}

Visible Text:
${compressed.visibleText}
${compressed.truncated ? '\n[DOM was truncated for token efficiency]' : ''}`;
}
