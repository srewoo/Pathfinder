/**
 * What the page actually talked to, distilled from captured HAR entries.
 *
 * Split out of `explorer-agent.ts` unchanged. It is a pure transform — HAR
 * entries in, deduplicated endpoint summaries out — with no knowledge of tabs,
 * the graph, or the crawl, so it belongs on its own rather than inside a 2,000
 * line orchestrator.
 */
import type { ObservedAPI } from '../../storage/schemas';
import type { HAREntry } from '../cdp/cdp-client';

/**
 * Extract API endpoint summaries from HAR entries, filtering out static assets,
 * browser-internal requests, and deduplicating by method+path.
 */
export function extractAPIEndpoints(
  entries: HAREntry[],
  context: ObservedAPI['context']
): ObservedAPI[] {
  const seen = new Set<string>();
  const apis: ObservedAPI[] = [];

  // Static asset extensions and patterns to skip
  const SKIP_PATTERNS = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map|webp|avif)(\?|$)/i;
  const SKIP_PREFIXES = ['chrome-extension://', 'data:', 'blob:'];

  for (const entry of entries) {
    if (SKIP_PATTERNS.test(entry.url)) continue;
    if (SKIP_PREFIXES.some((p) => entry.url.startsWith(p))) continue;
    // Skip HTML document loads — we want API calls only
    if (entry.mimeType?.includes('text/html') && entry.method === 'GET') continue;

    // Normalize: remove query params for deduplication
    let endpoint: string;
    try {
      const parsed = new URL(entry.url);
      endpoint = parsed.origin + parsed.pathname;
    } catch {
      endpoint = entry.url;
    }

    const dedup = `${entry.method}:${endpoint}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);

    apis.push({
      endpoint,
      method: entry.method,
      status: entry.status,
      requestContentType: entry.requestHeaders?.['content-type'] ?? entry.requestHeaders?.['Content-Type'],
      responseContentType: entry.mimeType || undefined,
      context,
    });
  }

  return apis.slice(0, 30); // Cap per page to prevent bloat
}