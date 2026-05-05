import { extractContent, extractLinks } from './extractor';
import { chunkText } from './chunker';
import { embedChunks } from './embedder';
import { invalidateVectorCache } from './vector-search';
import { describePageImages, injectImageDescriptions } from './image-describer';
import { vectorDB, documentDB } from '../../storage/indexed-db';
import type { AIClientInterface } from '../ai/ai-client';
import type { CrawledDocument, CrawlProgress, CrawlEvent } from '../../storage/schemas';
import { generateId, sha256 } from '../../utils/hash';
import { createLogger } from '../../utils/logger';

const log = createLogger('crawler');

const DEFAULT_FETCH_DELAY_MS = 100;
const DEFAULT_CONCURRENCY = 6;

// ── Adaptive Concurrency ────────────────────────────────────────────────────
// Dynamically adjusts concurrency based on server response times.
// Ramps up when responses are fast, throttles back on slow/error responses.

class AdaptiveConcurrency {
  private current: number;
  private readonly min: number;
  private readonly max: number;
  /** Rolling window of recent response times (ms). */
  private responseTimes: number[] = [];
  private consecutiveErrors = 0;
  /** P90 response time target (ms). Stay below this to ramp up. */
  private readonly targetP90Ms: number;

  constructor(initial: number, min = 2, max = 12, targetP90Ms = 3000) {
    this.current = initial;
    this.min = min;
    this.max = max;
    this.targetP90Ms = targetP90Ms;
  }

  get value(): number { return this.current; }

  /** Record a successful response with its latency. */
  recordSuccess(responseTimeMs: number): void {
    this.consecutiveErrors = 0;
    this.responseTimes.push(responseTimeMs);
    // Keep rolling window of last 20 responses
    if (this.responseTimes.length > 20) this.responseTimes.shift();
    this.adjust();
  }

  /** Record a failed request (timeout, 5xx, network error). */
  recordError(): void {
    this.consecutiveErrors++;
    // Aggressive backoff on consecutive errors
    if (this.consecutiveErrors >= 2) {
      this.current = Math.max(this.min, Math.floor(this.current * 0.5));
      log.info(`Adaptive concurrency: throttled to ${this.current} (${this.consecutiveErrors} consecutive errors)`);
    }
  }

  private adjust(): void {
    if (this.responseTimes.length < 5) return; // Need enough samples

    const sorted = [...this.responseTimes].sort((a, b) => a - b);
    const p90 = sorted[Math.floor(sorted.length * 0.9)];

    if (p90 < this.targetP90Ms * 0.5) {
      // Responses are fast — ramp up
      this.current = Math.min(this.max, this.current + 1);
    } else if (p90 > this.targetP90Ms) {
      // Responses are slow — throttle back
      this.current = Math.max(this.min, this.current - 1);
    }
  }
}

// ── Robots.txt Parser ───────────────────────────────────────────────────────
// Respects Disallow directives for our user agent and the wildcard agent.

interface RobotsRules {
  disallowPaths: string[];
  crawlDelayMs?: number;
}

function parseRobotsTxt(content: string): RobotsRules {
  const rules: RobotsRules = { disallowPaths: [] };
  const lines = content.split('\n');
  let inRelevantBlock = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith('#') || line.length === 0) continue;

    const lcLine = line.toLowerCase();

    if (lcLine.startsWith('user-agent:')) {
      const agent = lcLine.replace('user-agent:', '').trim();
      inRelevantBlock = agent === '*' || agent.includes('pathfinder');
      continue;
    }

    if (!inRelevantBlock) continue;

    if (lcLine.startsWith('disallow:')) {
      const path = line.replace(/^disallow:\s*/i, '').trim();
      if (path && path !== '/') { // Don't block everything
        rules.disallowPaths.push(path);
      }
    } else if (lcLine.startsWith('crawl-delay:')) {
      const delay = parseFloat(line.replace(/^crawl-delay:\s*/i, '').trim());
      if (!isNaN(delay) && delay > 0) {
        rules.crawlDelayMs = Math.min(delay * 1000, 10_000); // Cap at 10s
      }
    }
  }

  return rules;
}

function isBlockedByRobots(url: string, rules: RobotsRules): boolean {
  if (rules.disallowPaths.length === 0) return false;
  try {
    const path = new URL(url).pathname;
    return rules.disallowPaths.some((disallowed) => {
      // Handle wildcard patterns
      if (disallowed.includes('*')) {
        const regex = new RegExp('^' + disallowed.replace(/\*/g, '.*'));
        return regex.test(path);
      }
      return path.startsWith(disallowed);
    });
  } catch {
    return false;
  }
}

export interface CrawlOptions {
  maxDepth?: number;
  maxPages?: number;
  concurrency?: number;
  fetchDelayMs?: number;
  skipEmbedRateLimit?: boolean;
  fullRefresh?: boolean;
  describeImages?: boolean;
  authCookies?: Array<{ name: string; value: string; domain?: string }>;
  authHeaders?: Record<string, string>;
  renderJavaScript?: boolean;
  tabId?: number;
  /**
   * Additional tab IDs for parallel SPA rendering. When provided along with
   * `tabId`, pages are rendered across multiple tabs simultaneously instead
   * of sequentially. Dramatically improves SPA crawl throughput.
   */
  additionalTabIds?: number[];
  onProgress?: (progress: CrawlProgress) => void;
  /** Callback for crawl events (errors, warnings) for observability. */
  onEvent?: (event: CrawlEvent) => void;
  signal?: AbortSignal;
  /** Respect robots.txt Disallow directives. Default true. */
  respectRobots?: boolean;
}

export interface CrawlResult {
  docCount: number;
  vectorCount: number;
  skippedCount: number;
  errors: string[];
  /** Events emitted during crawl for diagnostic review. */
  events: CrawlEvent[];
}

function emitEvent(
  events: CrawlEvent[],
  onEvent: ((e: CrawlEvent) => void) | undefined,
  type: CrawlEvent['type'],
  url: string,
  message: string,
  code?: CrawlEvent['code']
): void {
  const event: CrawlEvent = { type, url, message, timestamp: new Date().toISOString(), code };
  events.push(event);
  onEvent?.(event);
  if (type === 'error') log.error(`[${code ?? 'unknown'}] ${url}: ${message}`);
  else if (type === 'warning') log.warn(`${url}: ${message}`);
}

export async function crawlSite(
  startUrl: string,
  aiClient: AIClientInterface,
  options: CrawlOptions = {}
): Promise<CrawlResult> {
  const {
    maxDepth = 3,
    maxPages = 200,
    concurrency: initialConcurrency = DEFAULT_CONCURRENCY,
    fetchDelayMs = DEFAULT_FETCH_DELAY_MS,
    skipEmbedRateLimit = false,
    fullRefresh = false,
    describeImages = false,
    authCookies,
    authHeaders,
    renderJavaScript = false,
    tabId: jsRenderTabId,
    additionalTabIds = [],
    onProgress,
    onEvent,
    signal,
    respectRobots = true,
  } = options;

  const adaptiveConcurrency = new AdaptiveConcurrency(initialConcurrency);

  const extraHeaders: Record<string, string> = { ...(authHeaders ?? {}) };
  if (authCookies && authCookies.length > 0) {
    extraHeaders['Cookie'] = authCookies.map((c) => `${c.name}=${c.value}`).join('; ');
    log.info(`Crawling with ${authCookies.length} auth cookies injected`);
  }

  if (fullRefresh) {
    try {
      await vectorDB.clear();
      await documentDB.clear();
      log.info('Full refresh — cleared existing data');
    } catch (clearErr) {
      log.error('Failed to clear existing data during full refresh — aborting to prevent orphaned records', clearErr);
      throw clearErr;
    }
  }
  invalidateVectorCache();

  // ── Robots.txt ─────────────────────────────────────────────────────────────
  let robotsRules: RobotsRules = { disallowPaths: [] };
  const events: CrawlEvent[] = [];

  if (respectRobots) {
    try {
      let origin: string;
      try { origin = new URL(startUrl).origin; } catch { origin = ''; }
      if (origin) {
        const robotsTxt = await fetchPage(`${origin}/robots.txt`, extraHeaders);
        if (robotsTxt) {
          robotsRules = parseRobotsTxt(robotsTxt);
          if (robotsRules.disallowPaths.length > 0) {
            log.info(`Robots.txt: ${robotsRules.disallowPaths.length} Disallow paths loaded`);
          }
          if (robotsRules.crawlDelayMs) {
            log.info(`Robots.txt: Crawl-Delay ${robotsRules.crawlDelayMs}ms will be respected`);
          }
        }
      }
    } catch {
      // robots.txt fetch failure is non-fatal
    }
  }

  const effectiveFetchDelay = Math.max(fetchDelayMs, robotsRules.crawlDelayMs ?? 0);

  const visited = new Set<string>();
  const pending = new Set<string>();

  const startNorm = normalizeUrl(startUrl);
  const queue: Array<{ url: string; depth: number }> = [{ url: startNorm, depth: 0 }];
  pending.add(startNorm);

  // Seed queue from sitemap.xml / robots.txt
  try {
    const sitemapUrls = await discoverSitemapUrls(startUrl, maxPages * 4, extraHeaders);
    let seeded = 0;
    for (const u of sitemapUrls) {
      const norm = normalizeUrl(u);
      if (!pending.has(norm) && !visited.has(norm)) {
        // Respect robots.txt for sitemap-discovered URLs too
        if (respectRobots && isBlockedByRobots(norm, robotsRules)) {
          emitEvent(events, onEvent, 'info', norm, 'Skipped — blocked by robots.txt', 'robots_blocked');
          continue;
        }
        queue.push({ url: norm, depth: 1 });
        pending.add(norm);
        seeded++;
      }
    }
    if (seeded > 0) log.info(`Sitemap seeded ${seeded} URLs into the crawl queue`);
  } catch (err) {
    log.debug('Sitemap discovery skipped', err);
  }

  const errors: string[] = [];
  let docCount = 0;
  let vectorCount = 0;
  let skippedCount = 0;

  // ── Build tab pool for parallel SPA rendering ───────────────────────────
  const tabPool: number[] = [];
  if (renderJavaScript && jsRenderTabId) {
    tabPool.push(jsRenderTabId);
    for (const tid of additionalTabIds) {
      if (tid !== jsRenderTabId) tabPool.push(tid);
    }
    if (tabPool.length > 1) {
      log.info(`Parallel SPA rendering enabled with ${tabPool.length} tabs`);
    }
  }

  while (queue.length > 0 && visited.size < maxPages) {
    if (signal?.aborted) break;

    const currentConcurrency = adaptiveConcurrency.value;
    const batch: Array<{ url: string; depth: number }> = [];
    while (queue.length > 0 && batch.length < currentConcurrency && visited.size + batch.length < maxPages) {
      const entry = queue.shift()!;
      pending.delete(entry.url);
      if (!visited.has(entry.url)) {
        // Check robots.txt
        if (respectRobots && isBlockedByRobots(entry.url, robotsRules)) {
          emitEvent(events, onEvent, 'info', entry.url, 'Skipped — blocked by robots.txt', 'robots_blocked');
          visited.add(entry.url);
          continue;
        }
        batch.push(entry);
        visited.add(entry.url);
      }
    }

    if (batch.length === 0) continue;

    onProgress?.({
      total: Math.min(queue.length + visited.size, maxPages),
      crawled: visited.size,
      embedded: docCount,
      skipped: skippedCount,
      currentUrl: batch[0].url,
      status: 'crawling',
    });

    log.info(`Crawling batch of ${batch.length} (concurrency: ${currentConcurrency}): ${batch.map((b) => b.url).join(', ')}`);

    // ── Fetch all pages in the batch ─────────────────────────────────────
    const fetchResults: PromiseSettledResult<{ url: string; html: string | null; responseTimeMs: number }>[] =
      renderJavaScript && tabPool.length > 0
        ? await fetchBatchRenderedParallel(batch.map((b) => b.url), tabPool, extraHeaders, events, onEvent)
        : await Promise.allSettled(
            batch.map(({ url }) => {
              const start = Date.now();
              return fetchPage(url, extraHeaders).then((html) => ({
                url,
                html,
                responseTimeMs: Date.now() - start,
              }));
            })
          );

    // ── Record response times for adaptive concurrency ───────────────────
    for (const result of fetchResults) {
      if (result.status === 'fulfilled' && result.value.html) {
        adaptiveConcurrency.recordSuccess(result.value.responseTimeMs);
      } else {
        adaptiveConcurrency.recordError();
      }
    }

    // ── Extract + change-detect all pages ────────────────────────────────
    type PageToEmbed = {
      url: string;
      depth: number;
      html: string;
      title: string;
      content: string;
      contentHash: string;
      hasExistingDoc: boolean;
      images: import('./extractor').ExtractedImage[];
    };
    const toEmbed: PageToEmbed[] = [];

    const hashChecks = await Promise.all(
      fetchResults.map(async (result, i) => {
        const { url } = batch[i];
        if (result.status === 'rejected') {
          emitEvent(events, onEvent, 'error', url, `Fetch failed: ${result.reason}`, 'fetch_failed');
          return null;
        }
        if (!result.value?.html) {
          emitEvent(events, onEvent, 'warning', url, 'No content returned (empty response or non-HTML)', 'fetch_failed');
          return null;
        }
        const { html } = result.value;
        let extracted;
        try {
          extracted = extractContent(html, url);
        } catch (err) {
          emitEvent(events, onEvent, 'error', url, `Content extraction failed: ${err instanceof Error ? err.message : String(err)}`, 'fetch_failed');
          return null;
        }
        if (extracted.content.length < 50) {
          emitEvent(events, onEvent, 'warning', url, 'Page content too short (<50 chars), skipping');
          return null;
        }
        const contentHash = await sha256(extracted.content);
        const existingDoc = await documentDB.getByUrl(url);
        return { url, depth: batch[i].depth, html, title: extracted.title, content: extracted.content, sections: extracted.sections, images: extracted.images, contentHash, existingDoc };
      })
    );

    for (const page of hashChecks) {
      if (!page) continue;
      const { url, depth, html, contentHash, existingDoc } = page;

      if (existingDoc?.contentHash === contentHash) {
        log.debug(`Unchanged (hash match): ${url}`);
        skippedCount++;
        if (depth < maxDepth) addLinks(extractLinks(html, url), depth, visited, pending, queue);
        onProgress?.({ total: Math.min(queue.length + visited.size, maxPages), crawled: visited.size, embedded: docCount, skipped: skippedCount, currentUrl: url, status: 'crawling' });
        continue;
      }

      if (existingDoc) {
        log.info(`Content changed, re-embedding: ${url}`);
        await Promise.all([vectorDB.deleteByUrl(url), documentDB.deleteByUrl(url)]);
      }

      toEmbed.push({ url, depth, html, title: page.title, content: page.content, contentHash, hasExistingDoc: !!existingDoc, images: page.images });

      if (depth < maxDepth) addLinks(extractLinks(html, url), depth, visited, pending, queue);
    }

    // ── Embed changed pages ──────────────────────────────────────────────
    if (toEmbed.length > 0) {
      onProgress?.({ total: Math.min(queue.length + visited.size, maxPages), crawled: visited.size, embedded: docCount, skipped: skippedCount, currentUrl: toEmbed.map((p) => p.url).join(', '), status: 'embedding' });

      for (const page of toEmbed) {
        if (signal?.aborted) break;
        let contentForChunking = page.content;
        if (describeImages && page.images.length > 0) {
          try {
            const imageDescs = await describePageImages(page.images, page.url, aiClient);
            if (imageDescs.size > 0) {
              contentForChunking = injectImageDescriptions(page.content, imageDescs);
              log.info(`Injected ${imageDescs.size} image descriptions into ${page.url}`);
            }
          } catch (err) {
            emitEvent(events, onEvent, 'warning', page.url, `Image description failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        const chunks = chunkText(contentForChunking, page.url);
        try {
          const vectors = await embedChunks(chunks, page.url, page.title, aiClient, {
            skipRateLimit: skipEmbedRateLimit,
          });
          const doc: CrawledDocument = {
            id: generateId(),
            url: page.url,
            title: page.title,
            content: page.content,
            crawledAt: new Date().toISOString(),
            chunkCount: chunks.length,
            contentHash: page.contentHash,
          };
          await vectorDB.putBatch(vectors);
          await documentDB.put(doc);
          docCount++;
          vectorCount += vectors.length;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          emitEvent(events, onEvent, 'error', page.url, `Embed/save failed: ${msg}`, 'embed_failed');
          errors.push(`${page.url}: ${msg}`);
        }
      }

      onProgress?.({ total: Math.min(queue.length + visited.size, maxPages), crawled: visited.size, embedded: docCount, skipped: skippedCount, currentUrl: '', status: 'crawling' });
    }

    if (queue.length > 0 && visited.size < maxPages) {
      await delay(effectiveFetchDelay);
    }
  }

  if (signal?.aborted) {
    log.info('Crawl stopped by user');
  }

  onProgress?.({
    total: visited.size,
    crawled: visited.size,
    embedded: docCount,
    skipped: skippedCount,
    currentUrl: '',
    status: 'done',
  });

  invalidateVectorCache();

  log.info(`Crawl done — embedded: ${docCount}, skipped (unchanged): ${skippedCount}, errors: ${errors.length}, events: ${events.length}`);

  return { docCount, vectorCount, skippedCount, errors, events };
}

function addLinks(
  links: string[],
  currentDepth: number,
  visited: Set<string>,
  pending: Set<string>,
  queue: Array<{ url: string; depth: number }>
): void {
  for (const link of links) {
    if (!visited.has(link) && !pending.has(link)) {
      queue.push({ url: link, depth: currentDepth + 1 });
      pending.add(link);
    }
  }
}

// Cache for conditional request headers
const conditionalHeaders = new Map<string, { lastModified?: string; etag?: string }>();

async function fetchPage(url: string, extraHeaders?: Record<string, string>): Promise<string | null> {
  const MAX_RETRIES = 3;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const cached = conditionalHeaders.get(url);
      const condHeaders: Record<string, string> = {};
      if (cached?.lastModified) condHeaders['If-Modified-Since'] = cached.lastModified;
      if (cached?.etag) condHeaders['If-None-Match'] = cached.etag;

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'pathfinder/1.0 (AI QA Assistant)',
          Accept: 'text/html,application/xhtml+xml,application/pdf',
          ...condHeaders,
          ...(extraHeaders ?? {}),
        },
        signal: AbortSignal.timeout(15000),
      });

      if (response.status === 304) {
        log.debug(`Not modified (304): ${url}`);
        return null;
      }

      if (response.status >= 400 && response.status < 500) return null;

      if (!response.ok) {
        if (attempt < MAX_RETRIES - 1) {
          await delay(1000 * Math.pow(2, attempt));
          continue;
        }
        return null;
      }

      const lastMod = response.headers.get('Last-Modified');
      const etag = response.headers.get('ETag');
      if (lastMod || etag) {
        conditionalHeaders.set(url, { lastModified: lastMod ?? undefined, etag: etag ?? undefined });
      }

      const contentType = response.headers.get('content-type') ?? '';

      if (contentType.includes('application/pdf')) {
        try {
          const buffer = await response.arrayBuffer();
          return extractPdfText(buffer, url);
        } catch {
          log.debug(`PDF extraction failed for ${url}`);
          return null;
        }
      }

      if (!contentType.includes('text/html')) return null;

      return await response.text();
    } catch {
      if (attempt < MAX_RETRIES - 1) {
        await delay(1000 * Math.pow(2, attempt));
        continue;
      }
      return null;
    }
  }

  return null;
}

/**
 * Extract text from a PDF ArrayBuffer as simple markdown.
 * Uses regex-based text extraction from the raw PDF stream.
 * Emits a warning event on failure instead of silently dropping.
 */
function extractPdfText(buffer: ArrayBuffer, url: string): string | null {
  try {
    const bytes = new Uint8Array(buffer);
    const raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes);

    const textBlocks: string[] = [];
    const btEtPattern = /BT\s([\s\S]*?)ET/g;
    let match;
    while ((match = btEtPattern.exec(raw)) !== null) {
      const block = match[1];
      const tjMatches = block.match(/\(([^)]*)\)\s*Tj/g) ?? [];
      for (const tj of tjMatches) {
        const text = tj.match(/\(([^)]*)\)/)?.[1];
        if (text) textBlocks.push(text);
      }
      const tjArrays = block.match(/\[([^\]]*)\]\s*TJ/g) ?? [];
      for (const tja of tjArrays) {
        const fragments = tja.match(/\(([^)]*)\)/g) ?? [];
        textBlocks.push(fragments.map((f) => f.slice(1, -1)).join(''));
      }
    }

    if (textBlocks.length === 0) return null;

    const text = textBlocks.join('\n').replace(/\\n/g, '\n').replace(/\\r/g, '').trim();
    if (text.length < 50) return null;

    return `<html><head><title>PDF: ${url}</title></head><body><article>${text}</article></body></html>`;
  } catch {
    return null;
  }
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    // Decode percent-encoded characters then re-encode for consistency.
    // This normalizes "hello%20world" and "hello world" to the same form.
    let path = decodeURIComponent(u.pathname);
    // Re-encode so the result is a valid URL
    path = path.split('/').map((seg) => encodeURIComponent(seg)).join('/');
    // Remove trailing slash (except root)
    if (path.length > 1 && path.endsWith('/')) {
      path = path.slice(0, -1);
    }
    // Lowercase the origin (scheme + host are case-insensitive per RFC 3986)
    return u.origin.toLowerCase() + path;
  } catch {
    return url;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function discoverSitemapUrls(startUrl: string, maxUrls: number, extraHeaders?: Record<string, string>): Promise<string[]> {
  let origin: string;
  try { origin = new URL(startUrl).origin; } catch { return []; }

  const urls = new Set<string>();
  const sitemapCandidates: string[] = [];

  const robotsTxt = await fetchPage(`${origin}/robots.txt`, extraHeaders);
  if (robotsTxt) {
    for (const line of robotsTxt.split('\n')) {
      const match = line.match(/^Sitemap:\s*(.+)/i);
      if (match?.[1]) sitemapCandidates.push(match[1].trim());
    }
  }

  sitemapCandidates.push(`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`);

  const BINARY_EXT = /\.(pdf|jpg|jpeg|png|gif|svg|mp4|webm|zip|tar|gz|exe|dmg)$/i;
  const visited = new Set<string>();
  const queue = [...new Set(sitemapCandidates)];

  while (queue.length > 0 && urls.size < maxUrls) {
    const sitemapUrl = queue.shift()!;
    if (visited.has(sitemapUrl)) continue;
    visited.add(sitemapUrl);

    const xml = await fetchPage(sitemapUrl, extraHeaders).catch(() => null);
    if (!xml) continue;

    const nestedSitemaps = [...xml.matchAll(/<sitemap>[\s\S]*?<loc>(.*?)<\/loc>/gi)];
    for (const m of nestedSitemaps) {
      const loc = m[1]?.trim();
      if (loc && !visited.has(loc)) queue.push(loc);
    }

    const pageUrls = [...xml.matchAll(/<url>[\s\S]*?<loc>(.*?)<\/loc>/gi)];
    for (const m of pageUrls) {
      const loc = m[1]?.trim();
      if (!loc) continue;
      try {
        const u = new URL(loc);
        if (u.origin === origin && !BINARY_EXT.test(u.pathname)) {
          urls.add(u.origin + u.pathname);
        }
      } catch { /* skip malformed */ }
      if (urls.size >= maxUrls) break;
    }
  }

  return [...urls];
}

// ── Parallel SPA Rendering via Tab Pool ─────────────────────────────────────
// Distributes page rendering across multiple browser tabs simultaneously.
// Falls back to static fetch on per-page failure.

async function fetchBatchRenderedParallel(
  urls: string[],
  tabPool: number[],
  extraHeaders?: Record<string, string>,
  events?: CrawlEvent[],
  onEvent?: (e: CrawlEvent) => void
): Promise<PromiseSettledResult<{ url: string; html: string | null; responseTimeMs: number }>[]> {
  if (tabPool.length === 0) {
    return Promise.allSettled(urls.map((url) => {
      const start = Date.now();
      return fetchPage(url, extraHeaders).then((html) => ({ url, html, responseTimeMs: Date.now() - start }));
    }));
  }

  // Single tab — sequential (original behavior)
  if (tabPool.length === 1) {
    const results: PromiseSettledResult<{ url: string; html: string | null; responseTimeMs: number }>[] = [];
    for (const url of urls) {
      const start = Date.now();
      try {
        const html = await fetchPageRendered(url, tabPool[0]);
        results.push({ status: 'fulfilled', value: { url, html, responseTimeMs: Date.now() - start } });
      } catch (err) {
        // Fall back to static fetch
        try {
          const html = await fetchPage(url, extraHeaders);
          results.push({ status: 'fulfilled', value: { url, html, responseTimeMs: Date.now() - start } });
        } catch (fetchErr) {
          if (events) emitEvent(events, onEvent, 'error', url, `Render + fetch fallback failed: ${fetchErr}`, 'render_failed');
          results.push({ status: 'rejected', reason: fetchErr });
        }
      }
    }
    return results;
  }

  // Multiple tabs — parallel rendering with tab rotation
  const results: PromiseSettledResult<{ url: string; html: string | null; responseTimeMs: number }>[] = new Array(urls.length);
  const tabBusy = new Map<number, boolean>();
  for (const tid of tabPool) tabBusy.set(tid, false);

  /** Wait for a free tab and return its ID. */
  async function acquireTab(): Promise<number> {
    while (true) {
      for (const [tid, busy] of tabBusy) {
        if (!busy) {
          tabBusy.set(tid, true);
          return tid;
        }
      }
      await delay(100);
    }
  }

  function releaseTab(tid: number): void {
    tabBusy.set(tid, false);
  }

  const tasks = urls.map(async (url, idx) => {
    const tabId = await acquireTab();
    const start = Date.now();
    try {
      const html = await fetchPageRendered(url, tabId);
      results[idx] = { status: 'fulfilled', value: { url, html, responseTimeMs: Date.now() - start } };
    } catch {
      // Fall back to static fetch
      try {
        const html = await fetchPage(url, extraHeaders);
        results[idx] = { status: 'fulfilled', value: { url, html, responseTimeMs: Date.now() - start } };
      } catch (fetchErr) {
        if (events) emitEvent(events, onEvent, 'error', url, `Render + fetch fallback failed`, 'render_failed');
        results[idx] = { status: 'rejected', reason: fetchErr };
      }
    } finally {
      releaseTab(tabId);
    }
  });

  await Promise.all(tasks);
  return results;
}

async function fetchPageRendered(url: string, tabId: number): Promise<string | null> {
  await new Promise<void>((resolve) => {
    let resolved = false;
    const done = () => { if (resolved) return; resolved = true; chrome.tabs.onUpdated.removeListener(listener); resolve(); };
    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === 'complete') done();
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url }).catch(() => done());
    setTimeout(done, 15_000);
  });

  await delay(1500);

  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.documentElement.outerHTML,
    });
    return result?.result as string ?? null;
  } catch {
    return null;
  }
}
