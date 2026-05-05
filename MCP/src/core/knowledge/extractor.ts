/**
 * HTML content extractor.
 *
 * In the MCP server (Node.js), we always use linkedom since there is no
 * browser DOMParser available.
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
  'iframe',
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
 * Always uses linkedom in the Node.js MCP server context.
 */
function parseHtml(html: string): Document {
  return new LinkedomDOMParser().parseFromString(html, 'text/html') as unknown as Document;
}

export function extractContent(html: string, url: string): ExtractedContent {
  const doc = parseHtml(html);

  const title = extractTitle(doc);

  REMOVE_SELECTORS.forEach((selector) => {
    try {
      doc.querySelectorAll(selector).forEach((el) => el.remove());
    } catch {
      // Ignore selectors that linkedom doesn't support (e.g. attribute selectors)
    }
  });

  const mainContent = findMainContent(doc);
  const images: ExtractedImage[] = [];
  const content = extractText(mainContent || doc.body, url, images);
  const sections = extractSections(mainContent || doc.body);

  return { title, content, url, sections, images };
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
      const key = l.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const raw = deduped.join('\n').replace(/\n{3,}/g, '\n\n');

  // Strip any residual HTML tags that may slip through malformed or
  // partially-rendered markup.
  return stripResidualHtml(raw);
}

/**
 * Removes any remaining `<tag ...>` or `</tag>` patterns from plain text.
 * `textContent` on well-formed DOM already does this; this is a safety net
 * for edge cases where raw HTML strings reach the output.
 */
function stripResidualHtml(text: string): string {
  return text
    .replace(/<[^>]{0,200}>/g, '')   // strip tags (cap at 200 chars to avoid backtracking on malformed input)
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
    // Use numeric literals — Node global may not exist in all contexts
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
