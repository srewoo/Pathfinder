/**
 * HTML content extractor.
 *
 * DOMParser is a browser Window API that is NOT available in Chrome Extension
 * Service Workers (MV3). We detect the environment and fall back to `linkedom`
 * — a pure-JS DOM implementation — when running in a service worker context.
 * In browser contexts (sidepanel, content scripts) the native DOMParser is used.
 */
import { DOMParser as LinkedomDOMParser } from 'linkedom';

export interface ExtractedImage {
  /** Absolute URL of the image. */
  src: string;
  /** Alt text, if any. */
  alt: string;
  /** Position marker in the extracted text, e.g. "[Image: alt text]" or "[Image: unnamed]". */
  placeholder: string;
}

export interface ExtractedContent {
  title: string;
  content: string;
  url: string;
  sections: string[];
  /** Images found inside the main content area (not header/footer/nav). */
  images: ExtractedImage[];
}

const REMOVE_SELECTORS = [
  'script',
  'style',
  'noscript',
  'svg',
  // Note: iframe is intentionally NOT removed — same-origin iframe content is extracted
  // Cookie / GDPR banners
  '[class*="cookie"]',
  '[id*="cookie"]',
  '[class*="gdpr"]',
  '[id*="gdpr"]',
  '[class*="consent"]',
  // Chat widgets (Intercom, Drift, Zendesk, etc.)
  '[id*="intercom"]',
  '[class*="intercom"]',
  '[id*="drift"]',
  '[class*="drift"]',
  '[id*="hubspot"]',
  '[class*="chat-widget"]',
  // Promotional / subscription banners
  '[class*="promo-bar"]',
  '[class*="announcement-bar"]',
  '[class*="subscribe-banner"]',
  '[class*="newsletter"]',
  // Generic aria-hidden decorative noise
  '[aria-hidden="true"]',
  '[role="presentation"]',
];

const HEADING_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];


/**
 * Returns a parsed Document from raw HTML.
 * Uses native DOMParser in browser contexts, linkedom in service worker context.
 */
function parseHtml(html: string): Document {
  if (typeof globalThis.DOMParser !== 'undefined') {
    return new globalThis.DOMParser().parseFromString(html, 'text/html');
  }
  // Service worker fallback — linkedom implements the same query API
  return new LinkedomDOMParser().parseFromString(html, 'text/html') as unknown as Document;
}

export function extractContent(html: string, url: string): ExtractedContent {
  const doc = parseHtml(html);

  const title = extractTitle(doc);

  // Extract structured data BEFORE removing elements
  const structuredData = extractStructuredData(doc);
  const iframeContent = extractIframeContent(doc);

  REMOVE_SELECTORS.forEach((selector) => {
    try {
      doc.querySelectorAll(selector).forEach((el) => el.remove());
    } catch {
      // Ignore selectors that linkedom doesn't support (e.g. attribute selectors)
    }
  });

  const mainContent = findMainContent(doc);
  const images: ExtractedImage[] = [];
  let content = extractText(mainContent || doc.body, url, images);
  const sections = extractSections(mainContent || doc.body);

  // Append structured data and iframe content if found
  if (structuredData) {
    content += '\n\n' + structuredData;
  }
  if (iframeContent) {
    content += '\n\n[Embedded Content]\n' + iframeContent;
  }

  return { title, content, url, sections, images };
}

/** Extract JSON-LD structured data and OpenAPI specs from the page. */
function extractStructuredData(doc: Document): string | null {
  const parts: string[] = [];

  // JSON-LD blocks (schema.org, OpenAPI, etc.)
  doc.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
    try {
      const data = JSON.parse(script.textContent ?? '');
      const type = data['@type'] ?? data.type ?? 'Unknown';
      // Extract key properties based on schema type
      if (type === 'FAQPage' && Array.isArray(data.mainEntity)) {
        parts.push('## FAQ');
        data.mainEntity.forEach((q: { name?: string; acceptedAnswer?: { text?: string } }) => {
          if (q.name) parts.push(`Q: ${q.name}`);
          if (q.acceptedAnswer?.text) parts.push(`A: ${q.acceptedAnswer.text}`);
        });
      } else if (type === 'HowTo' && Array.isArray(data.step)) {
        parts.push(`## How To: ${data.name ?? ''}`);
        data.step.forEach((s: { text?: string; name?: string }, i: number) => {
          parts.push(`${i + 1}. ${s.name ?? s.text ?? ''}`);
        });
      } else if (data.openapi || data.swagger) {
        // OpenAPI/Swagger spec embedded in JSON-LD
        parts.push('## API Specification');
        if (data.info?.title) parts.push(`API: ${data.info.title}`);
        if (data.info?.description) parts.push(data.info.description);
        if (data.paths) {
          for (const [path, methods] of Object.entries(data.paths)) {
            for (const [method, spec] of Object.entries(methods as Record<string, { summary?: string; description?: string }>)) {
              if (typeof spec === 'object' && spec) {
                parts.push(`- ${method.toUpperCase()} ${path}: ${spec.summary ?? spec.description ?? ''}`);
              }
            }
          }
        }
      }
    } catch { /* skip malformed JSON-LD */ }
  });

  return parts.length > 0 ? parts.join('\n') : null;
}

/** Extract text content from same-origin iframe src attributes. */
function extractIframeContent(doc: Document): string | null {
  const parts: string[] = [];

  doc.querySelectorAll('iframe[src]').forEach((iframe) => {
    const src = iframe.getAttribute('src') ?? '';
    // Only capture same-origin iframe references (actual content fetched separately)
    if (src && !src.startsWith('javascript:') && !src.startsWith('about:')) {
      const title = iframe.getAttribute('title') ?? iframe.getAttribute('aria-label') ?? '';
      parts.push(`[iframe: ${title || src}]`);
    }
  });

  return parts.length > 0 ? parts.join('\n') : null;
}

function extractTitle(doc: Document): string {
  const h1 = doc.querySelector('h1');
  if (h1?.textContent?.trim()) return h1.textContent.trim();

  const title = doc.querySelector('title');
  if (title?.textContent?.trim()) {
    return title.textContent.split('|')[0]?.trim() ?? title.textContent.trim();
  }

  return '';
}

function findMainContent(doc: Document): Element | null {
  const candidates = [
    doc.querySelector('main'),
    doc.querySelector('[role="main"]'),
    doc.querySelector('article'),
    doc.querySelector('.content'),
    doc.querySelector('#content'),
    doc.querySelector('.article'),
    doc.querySelector('.post-content'),
    doc.querySelector('.entry-content'),
    doc.querySelector('.documentation'),
    doc.querySelector('.docs-content'),
  ];

  return candidates.find(Boolean) ?? null;
}

function extractText(element: Element | null, pageUrl: string, images: ExtractedImage[]): string {
  if (!element) return '';

  const lines: string[] = [];
  extractTextNodes(element, lines, pageUrl, images);

  // Deduplicate repeated lines (boilerplate nav items that survived removal,
  // copy-pasted footer text, repeated section titles, etc.).
  const seen = new Set<string>();
  const deduped = lines
    .map((l) => l.trim())
    .filter((l) => {
      if (l.length === 0) return false;
      // Always keep headings even if repeated (structural markers)
      if (l.startsWith('## ')) return true;
      // Deduplicate by normalized whitespace but preserve case —
      // "API" and "api" are distinct in technical docs.
      const key = l.replace(/\s+/g, ' ');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const raw = deduped.join('\n').replace(/\n{3,}/g, '\n\n');

  // Strip any residual HTML tags that may slip through malformed or
  // partially-rendered markup (especially in linkedom's service-worker context).
  return stripResidualHtml(raw);
}

/**
 * Removes any remaining `<tag ...>` or `</tag>` patterns from plain text.
 * `textContent` on well-formed DOM already does this; this is a safety net
 * for edge cases where raw HTML strings reach the output.
 */
function stripResidualHtml(text: string): string {
  return text
    .replace(/<\/?[a-zA-Z][^>]{0,200}>/g, '')   // strip HTML tags only (requires letter after <, preserves `x < 5`)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{3,}/g, '  ')        // collapse excessive whitespace
    .trim();
}


function extractTextNodes(element: Element, lines: string[], pageUrl: string, images: ExtractedImage[]): void {
  const tag = element.tagName?.toLowerCase();

  if (HEADING_TAGS.includes(tag)) {
    const text = element.textContent?.trim();
    if (text) lines.push(`\n## ${text}\n`);
    return;
  }

  if (tag === 'li') {
    const text = element.textContent?.trim();
    if (text) lines.push(`• ${text}`);
    return;
  }

  if (tag === 'p' || tag === 'blockquote') {
    const text = element.textContent?.trim();
    if (text) lines.push(text);
    return;
  }

  if (tag === 'code' || tag === 'pre') {
    const text = element.textContent?.trim();
    if (!text) return;
    const lang = element.getAttribute?.('class')?.match(/language-(\w+)/)?.[1] ?? '';
    lines.push(`\`\`\`${lang}\n${text}\n\`\`\``);
    return;
  }

  if (tag === 'img') {
    const alt = (element as HTMLImageElement).getAttribute?.('alt')?.trim() ?? '';
    const src = (element as HTMLImageElement).getAttribute?.('src')?.trim() ?? '';
    const width = parseInt((element as HTMLImageElement).getAttribute?.('width') ?? '0', 10);
    const height = parseInt((element as HTMLImageElement).getAttribute?.('height') ?? '0', 10);

    // Skip tiny images (icons, logos, spacers)
    if ((width > 0 && width < 80) || (height > 0 && height < 80)) return;

    const placeholder = alt && alt.length > 5 ? `[Image: ${alt}]` : src ? '[Image: unnamed]' : '';
    if (placeholder) lines.push(placeholder);

    // Collect image for optional vision description
    if (src) {
      let absoluteSrc = src;
      try {
        absoluteSrc = new URL(src, pageUrl).href;
      } catch { /* keep as-is */ }

      // Skip data URIs that are tiny (likely tracking pixels) and non-image URLs
      const isDataUri = absoluteSrc.startsWith('data:');
      if (!isDataUri || absoluteSrc.length > 500) {
        images.push({ src: absoluteSrc, alt, placeholder });
      }
    }
    return;
  }

  if (tag === 'figcaption') {
    const text = element.textContent?.trim();
    if (text) lines.push(`[Caption: ${text}]`);
    return;
  }

  if (tag === 'table') {
    const tableText = extractTable(element);
    if (tableText) lines.push(tableText);
    return;
  }

  if (tag === 'nav') {
    const links: string[] = [];
    element.querySelectorAll('a').forEach((a) => {
      const text = a.textContent?.trim();
      const href = a.getAttribute?.('href');
      if (text && href && !href.startsWith('#') && !href.startsWith('javascript:')) {
        links.push(text);
      }
    });
    if (links.length > 0 && links.length <= 20) {
      lines.push(`[Navigation: ${links.join(', ')}]`);
    }
    return;
  }

  element.childNodes.forEach((node) => {
    // Node.TEXT_NODE = 3, Node.ELEMENT_NODE = 1
    // Use numeric literals — Node global may not exist in service worker context
    if (node.nodeType === 3) {
      const text = node.textContent?.trim();
      if (text && text.length > 1) lines.push(text);
    } else if (node.nodeType === 1) {
      extractTextNodes(node as Element, lines, pageUrl, images);
    }
  });
}

function extractTable(table: Element): string {
  const rows: string[][] = [];
  table.querySelectorAll('tr').forEach((tr) => {
    const cells: string[] = [];
    tr.querySelectorAll('th, td').forEach((cell) => {
      cells.push((cell.textContent?.trim() ?? '').replace(/\s+/g, ' '));
    });
    if (cells.length > 0) rows.push(cells);
  });
  if (rows.length === 0) return '';
  // Format as markdown-style table
  const header = rows[0];
  const lines = [header.join(' | ')];
  if (rows.length > 1) {
    lines.push(header.map(() => '---').join(' | '));
    rows.slice(1).forEach((row) => lines.push(row.join(' | ')));
  }
  return '\n' + lines.join('\n') + '\n';
}

function extractSections(element: Element | null): string[] {
  if (!element) return [];

  const sections: string[] = [];
  const headings = element.querySelectorAll('h1, h2, h3');

  headings.forEach((heading) => {
    const text = heading.textContent?.trim();
    if (text) sections.push(text);
  });

  return sections;
}

export function extractLinks(html: string, baseUrl: string): string[] {
  const doc = parseHtml(html);
  const base = new URL(baseUrl);
  const links: string[] = [];

  doc.querySelectorAll('a[href]').forEach((anchor) => {
    try {
      const href = anchor.getAttribute('href') ?? '';
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
      const url = new URL(href, base);

      if (
        url.hostname === base.hostname &&
        !url.hash &&
        !href.match(/\.(pdf|jpg|jpeg|png|gif|svg|mp4|zip|tar|gz)$/i)
      ) {
        links.push(url.origin + url.pathname);
      }
    } catch {
      // Invalid URL — skip
    }
  });

  return [...new Set(links)];
}
