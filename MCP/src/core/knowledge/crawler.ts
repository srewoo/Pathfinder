import { extractContent, extractLinks } from './extractor.js';
import { chunkText } from './chunker.js';
import { embedChunks } from './embedder.js';
import { invalidateVectorCache } from './vector-search.js';
import { describePageImages, injectImageDescriptions } from './image-describer.js';
import { vectorRepo } from '../../storage/repositories/vector-repo.js';
import { documentRepo } from '../../storage/repositories/document-repo.js';
import type { AIClientInterface } from '../ai/ai-client.js';
import type { CrawledDocument, CrawlProgress } from '../../storage/schemas.js';
import { generateId, simpleHash } from '../../utils/hash.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('crawler');

/**
 * Polite delay between batches of concurrent page fetches.
 * With concurrency=6 this is ~17 ms per-page equivalent — still respectful of servers.
 */
const DEFAULT_FETCH_DELAY_MS = 100;

/** Number of pages fetched in parallel per round. */
const DEFAULT_CONCURRENCY = 6;

export interface CrawlOptions {
  maxDepth?: number;
  maxPages?: number;
  /** Number of pages to fetch concurrently per round. Default: 6. */
  concurrency?: number;
  /** Delay in ms between concurrent fetch rounds. Default: 100 ms. */
  fetchDelayMs?: number;
  /**
   * Skip the per-batch rate-limit delay inside the embedder.
   * Set to true when using local embeddings (no API rate limits apply).
   */
  skipEmbedRateLimit?: boolean;
  /**
   * When true, clear all existing data and re-embed every page from scratch.
   * When false (default), only re-embed pages whose content has changed.
   */
  fullRefresh?: boolean;
  /**
   * When true, use the vision LLM to describe images found in article content.
   * Adds one API call per image. Only processes images inside the main content area.
   */
  describeImages?: boolean;
  onProgress?: (progress: CrawlProgress) => void;
  /** AbortSignal to stop the crawl early. */
  signal?: AbortSignal;
}

export interface CrawlResult {
  docCount: number;
  vectorCount: number;
  skippedCount: number;
  errors: string[];
}

export async function crawlSite(
  startUrl: string,
  aiClient: AIClientInterface,
  options: CrawlOptions = {}
): Promise<CrawlResult> {
  const {
    maxDepth = 3,
    maxPages = 200,
    concurrency = DEFAULT_CONCURRENCY,
    fetchDelayMs = DEFAULT_FETCH_DELAY_MS,
    skipEmbedRateLimit = false,
    fullRefresh = false,
    describeImages = false,
    onProgress,
    signal,
  } = options;

  if (fullRefresh) {
    await vectorRepo.clear();
    await documentRepo.clear();
    log.info('Full refresh — cleared existing data');
  }
  invalidateVectorCache();

  const visited = new Set<string>();
  // O(1) dedup for queued URLs — avoids O(n) Array.some() scan.
  const pending = new Set<string>();

  const startNorm = normalizeUrl(startUrl);
  const queue: Array<{ url: string; depth: number }> = [{ url: startNorm, depth: 0 }];
  pending.add(startNorm);

  // Seed queue from sitemap.xml / robots.txt before BFS starts.
  // Sitemaps give us a complete, canonical URL list without relying purely on link-following.
  try {
    const sitemapUrls = await discoverSitemapUrls(startUrl, maxPages * 4);
    let seeded = 0;
    for (const u of sitemapUrls) {
      const norm = normalizeUrl(u);
      if (!pending.has(norm) && !visited.has(norm)) {
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

  while (queue.length > 0 && visited.size < maxPages) {
    if (signal?.aborted) break;
    // Build a batch of up to `concurrency` unvisited URLs.
    const batch: Array<{ url: string; depth: number }> = [];
    while (queue.length > 0 && batch.length < concurrency && visited.size + batch.length < maxPages) {
      const entry = queue.shift()!;
      pending.delete(entry.url);
      if (!visited.has(entry.url)) {
        batch.push(entry);
        // Mark eagerly so parallel workers don't duplicate work.
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

    log.info(`Crawling batch of ${batch.length}: ${batch.map((b) => b.url).join(', ')}`);

    // ── Fetch all pages in the batch concurrently ──────────────────────────
    const fetchResults = await Promise.allSettled(
      batch.map(({ url }) => fetchPage(url).then((html) => ({ url, html })))
    );

    // ── Extract + change-detect all pages ──────────────────────────────────
    // Collect pages that need embedding; handle unchanged/thin pages inline.
    type PageToEmbed = {
      url: string;
      depth: number;
      html: string;
      title: string;
      content: string;
      contentHash: string;
      hasExistingDoc: boolean;
      images: import('./extractor.js').ExtractedImage[];
    };
    const toEmbed: PageToEmbed[] = [];

    // Run hash-check lookups in parallel across the whole batch.
    const hashChecks = await Promise.all(
      fetchResults.map(async (result, i) => {
        const { url } = batch[i];
        if (result.status === 'rejected' || !result.value?.html) return null;
        const { html } = result.value;
        let extracted;
        try {
          extracted = extractContent(html, url);
        } catch {
          return null;
        }
        if (extracted.content.length < 50) return null;
        const contentHash = simpleHash(extracted.content);
        const existingDoc = await documentRepo.getByUrl(url);
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

      // Stale — remove old vectors/doc before re-embedding.
      if (existingDoc) {
        log.info(`Content changed, re-embedding: ${url}`);
        await Promise.all([vectorRepo.deleteByUrl(url), documentRepo.deleteByUrl(url)]);
      }

      toEmbed.push({ url, depth, html, title: page.title, content: page.content, contentHash, hasExistingDoc: !!existingDoc, images: page.images });

      // Enqueue outbound links immediately so the next fetch round has work while we embed.
      if (depth < maxDepth) addLinks(extractLinks(html, url), depth, visited, pending, queue);
    }

    // ── Embed changed pages sequentially to avoid API rate-limit storms ─────
    if (toEmbed.length > 0) {
      onProgress?.({ total: Math.min(queue.length + visited.size, maxPages), crawled: visited.size, embedded: docCount, skipped: skippedCount, currentUrl: toEmbed.map((p) => p.url).join(', '), status: 'embedding' });

      for (const page of toEmbed) {
        if (signal?.aborted) break;
        // Optionally describe images via vision LLM and inject descriptions into text
        let contentForChunking = page.content;
        if (describeImages && page.images.length > 0) {
          try {
            const imageDescs = await describePageImages(page.images, page.url, aiClient);
            if (imageDescs.size > 0) {
              contentForChunking = injectImageDescriptions(page.content, imageDescs);
              log.info(`Injected ${imageDescs.size} image descriptions into ${page.url}`);
            }
          } catch (err) {
            log.warn(`Image description failed for ${page.url}, continuing without`, err);
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
          await vectorRepo.putBatch(vectors);
          await documentRepo.put(doc);
          docCount++;
          vectorCount += vectors.length;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`Embed/save failed: ${page.url}`, err);
          errors.push(`${page.url}: ${msg}`);
        }
      }

      onProgress?.({ total: Math.min(queue.length + visited.size, maxPages), crawled: visited.size, embedded: docCount, skipped: skippedCount, currentUrl: '', status: 'crawling' });
    }

    // Brief polite delay between fetch rounds.
    if (queue.length > 0 && visited.size < maxPages) {
      await delay(fetchDelayMs);
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

  // Flush in-memory cache so the next RAG search reflects the freshly written vectors.
  invalidateVectorCache();

  log.info(`Crawl done — embedded: ${docCount}, skipped (unchanged): ${skippedCount}, errors: ${errors.length}`);

  return { docCount, vectorCount, skippedCount, errors };
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

async function fetchPage(url: string): Promise<string | null> {
  const MAX_RETRIES = 3;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'pathfinder/1.0 (AI QA Assistant)',
          Accept: 'text/html,application/xhtml+xml',
        },
        signal: AbortSignal.timeout(15000),
      });

      // Don't retry client errors (4xx) — they won't succeed
      if (response.status >= 400 && response.status < 500) return null;

      // Retry server errors (5xx)
      if (!response.ok) {
        if (attempt < MAX_RETRIES - 1) {
          await delay(1000 * Math.pow(2, attempt));
          continue;
        }
        return null;
      }

      const contentType = response.headers.get('content-type') ?? '';
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

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    // Strip trailing slash (except for root), query params, and fragments
    let path = u.pathname;
    if (path.length > 1 && path.endsWith('/')) {
      path = path.slice(0, -1);
    }
    return u.origin + path;
  } catch {
    return url;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Discover URLs from sitemap.xml / sitemap_index.xml / robots.txt.
 * Returns same-origin, non-binary page URLs (up to maxUrls).
 */
async function discoverSitemapUrls(startUrl: string, maxUrls: number): Promise<string[]> {
  let origin: string;
  try { origin = new URL(startUrl).origin; } catch { return []; }

  const urls = new Set<string>();

  // 1. Try robots.txt → extract Sitemap: directives
  const robotsTxt = await fetchPage(`${origin}/robots.txt`);
  const sitemapCandidates: string[] = [];

  if (robotsTxt) {
    for (const line of robotsTxt.split('\n')) {
      const match = line.match(/^Sitemap:\s*(.+)/i);
      if (match?.[1]) sitemapCandidates.push(match[1].trim());
    }
  }

  // 2. Always try default locations
  sitemapCandidates.push(`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`);

  const BINARY_EXT = /\.(pdf|jpg|jpeg|png|gif|svg|mp4|webm|zip|tar|gz|exe|dmg)$/i;

  // 3. Fetch and parse each sitemap (including sitemap indexes)
  const visited = new Set<string>();
  const queue = [...new Set(sitemapCandidates)];

  while (queue.length > 0 && urls.size < maxUrls) {
    const sitemapUrl = queue.shift()!;
    if (visited.has(sitemapUrl)) continue;
    visited.add(sitemapUrl);

    const xml = await fetchPage(sitemapUrl).catch(() => null);
    if (!xml) continue;

    // Sitemap index — extract nested <sitemap><loc> entries
    const nestedSitemaps = [...xml.matchAll(/<sitemap>[\s\S]*?<loc>(.*?)<\/loc>/gi)];
    for (const m of nestedSitemaps) {
      const loc = m[1]?.trim();
      if (loc && !visited.has(loc)) queue.push(loc);
    }

    // Regular sitemap — extract <url><loc> entries
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
