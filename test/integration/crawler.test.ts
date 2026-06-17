/**
 * Integration test: documentation crawler (crawlSite)
 *
 * Verifies the crawler fixes:
 *  - robots.txt (text/plain) and sitemap.xml (application/xml) are fetched via
 *    fetchRaw — the old HTML-only content-type gate silently dropped both
 *  - sitemap-discovered pages are actually crawled
 *  - auth cookies are seeded into the cookie jar (the Cookie request header is
 *    forbidden by the browser)
 *
 * Network (global fetch), embeddings, chunking, extraction, and storage are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/core/knowledge/extractor', () => ({
  extractContent: vi.fn().mockReturnValue({
    title: 'Doc', content: 'x'.repeat(500), sections: [], images: [],
  }),
  extractLinks: vi.fn().mockReturnValue([]),
}));
vi.mock('../../src/core/knowledge/chunker', () => ({ chunkText: vi.fn().mockReturnValue(['chunk']) }));
vi.mock('../../src/core/knowledge/embedder', () => ({
  embedChunks: vi.fn().mockResolvedValue([{ id: 'v1', vector: [0.1], text: 'chunk', url: '', title: 'Doc' }]),
}));
vi.mock('../../src/core/knowledge/vector-search', () => ({ invalidateVectorCache: vi.fn() }));
vi.mock('../../src/core/knowledge/image-describer', () => ({
  describePageImages: vi.fn().mockResolvedValue(new Map()),
  injectImageDescriptions: vi.fn((c: string) => c),
}));
vi.mock('../../src/storage/indexed-db', () => ({
  vectorDB: { clear: vi.fn().mockResolvedValue(undefined), deleteByUrl: vi.fn().mockResolvedValue(undefined), putBatch: vi.fn().mockResolvedValue(undefined) },
  documentDB: {
    clear: vi.fn().mockResolvedValue(undefined),
    getAll: vi.fn().mockResolvedValue([]),
    getByUrl: vi.fn().mockResolvedValue(null),
    deleteByUrl: vi.fn().mockResolvedValue(undefined),
    put: vi.fn().mockResolvedValue(undefined),
  },
}));

import { crawlSite } from '../../src/core/knowledge/crawler';
import { documentDB } from '../../src/storage/indexed-db';
import { embedChunks } from '../../src/core/knowledge/embedder';

const ORIGIN = 'https://docs.test';

/** Build a minimal Response-like for the fetch mock. */
function res(body: string, contentType: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  };
}

const SITEMAP_XML = `<?xml version="1.0"?><urlset><url><loc>${ORIGIN}/guide</loc></url></urlset>`;

describe('crawlSite', () => {
  const aiClient = { chat: vi.fn(), embed: vi.fn() } as never;

  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis.chrome as unknown as { cookies: { set: ReturnType<typeof vi.fn> } }).cookies.set = vi.fn().mockResolvedValue({});
    vi.mocked(documentDB.getAll).mockResolvedValue([]);

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/robots.txt') return res(`User-agent: *\nSitemap: ${ORIGIN}/sitemap.xml`, 'text/plain; charset=utf-8');
      if (path === '/sitemap.xml') return res(SITEMAP_XML, 'application/xml');
      if (path === '/sitemap_index.xml') return res('', 'application/xml', 404);
      // Any real HTML page.
      return res('<html><body><article>content</article></body></html>', 'text/html');
    }));
  });

  it('given a sitemap served as application/xml when crawling then sitemap pages ARE crawled', async () => {
    const result = await crawlSite(`${ORIGIN}/`, aiClient, { maxPages: 10, maxDepth: 1 });

    // /guide is only discoverable via the sitemap (robots.txt text/plain →
    // Sitemap directive → sitemap.xml application/xml). Both must parse via
    // fetchRaw for this to be > 1.
    expect(result.docCount).toBeGreaterThanOrEqual(2);
  });

  it('given a robots.txt served as text/plain when crawling then it is fetched (not content-type rejected)', async () => {
    await crawlSite(`${ORIGIN}/`, aiClient, { maxPages: 5 });
    const fetchMock = vi.mocked(globalThis.fetch as never);
    const fetchedRobots = (fetchMock.mock.calls as unknown as Array<[string]>).some(([u]) => u.includes('/robots.txt'));
    expect(fetchedRobots).toBe(true);
  });

  it('given auth cookies when crawling then they are seeded into the cookie jar', async () => {
    await crawlSite(`${ORIGIN}/`, aiClient, {
      maxPages: 2,
      authCookies: [{ name: 'session', value: 'abc123' }],
    });

    const cookieSet = (globalThis.chrome as unknown as { cookies: { set: ReturnType<typeof vi.fn> } }).cookies.set;
    expect(cookieSet).toHaveBeenCalledWith(expect.objectContaining({ name: 'session', value: 'abc123', url: ORIGIN }));
  });

  it('given a prior crawl with ETags when re-crawling then unchanged pages 304, skip embedding, and still follow stored links', async () => {
    // Simulate a previous crawl: /guide stored with an ETag + an outlink.
    vi.mocked(documentDB.getAll).mockResolvedValue([
      { id: 'd1', url: `${ORIGIN}/guide`, title: 'Guide', content: 'old', crawledAt: '2026-01-01', chunkCount: 1, contentHash: 'h1', etag: '"abc"', links: [`${ORIGIN}/from-cache`] },
    ] as never);

    const seen: Array<{ path: string; ifNoneMatch?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const headers = init?.headers as Record<string, string> | undefined;
      seen.push({ path, ifNoneMatch: headers?.['If-None-Match'] });
      if (path === '/robots.txt') return res(`User-agent: *\nSitemap: ${ORIGIN}/sitemap.xml`, 'text/plain');
      if (path === '/sitemap.xml') return res(SITEMAP_XML, 'application/xml');
      if (path === '/sitemap_index.xml') return res('', 'application/xml', 404);
      if (path === '/guide') return res('', 'text/html', 304); // unchanged → 304
      return res('<html><body><article>content</article></body></html>', 'text/html');
    }));

    const result = await crawlSite(`${ORIGIN}/`, aiClient, { maxPages: 10, maxDepth: 3 });

    // The conditional request carried the stored ETag.
    expect(seen.find((s) => s.path === '/guide')?.ifNoneMatch).toBe('"abc"');
    // 304 page counted as skipped (not embedded).
    expect(result.skippedCount).toBeGreaterThanOrEqual(1);
    const embeddedUrls = vi.mocked(embedChunks).mock.calls.map((c) => c[1]);
    expect(embeddedUrls).not.toContain(`${ORIGIN}/guide`);
    // BFS continued from the 304 page's stored outlink.
    expect(embeddedUrls).toContain(`${ORIGIN}/from-cache`);
  });

  it('given credentialed fetch when crawling then page requests include credentials', async () => {
    await crawlSite(`${ORIGIN}/`, aiClient, { maxPages: 2 });
    const fetchMock = vi.mocked(globalThis.fetch as never);
    const pageCall = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>).find(([u]) => new URL(u).pathname === '/');
    expect(pageCall?.[1]?.credentials).toBe('include');
  });
});
