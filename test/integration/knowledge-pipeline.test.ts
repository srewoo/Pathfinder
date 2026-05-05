/**
 * Integration test: Knowledge Builder pipeline
 *
 * Tests the full flow: HTML → extract → chunk → embed → store in IndexedDB → search
 * Only the AI embedding call is mocked (external API boundary).
 * IndexedDB uses fake-indexeddb for a real in-memory implementation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';

import { extractContent, extractLinks } from '../../src/core/knowledge/extractor';
import { chunkText } from '../../src/core/knowledge/chunker';
import { embedChunks } from '../../src/core/knowledge/embedder';
import { vectorDB, documentDB } from '../../src/storage/indexed-db';
import { search, formatSearchResults } from '../../src/core/knowledge/vector-search';
import { generateId } from '../../src/utils/hash';
import type { AIClientInterface } from '../../src/core/ai/ai-client';
import type { CrawledDocument } from '../../src/storage/schemas';

// --- AI client stub (only embed is used in this pipeline) ---
function makeAIStub(dimensions = 8): AIClientInterface {
  return {
    chat: vi.fn(),
    embed: vi.fn(async (texts: string[]) =>
      texts.map(() => Array.from({ length: dimensions }, () => Math.random()))
    ),
  };
}

const SAMPLE_HTML = `
<!DOCTYPE html>
<html>
  <head><title>Getting Started Guide</title></head>
  <body>
    <main>
      <h1>Getting Started</h1>
      <p>Welcome to the platform. This guide helps you set up your account and explore the main features.</p>
      <h2>Step 1: Create an Account</h2>
      <p>Navigate to the signup page and fill in your name, email address, and a secure password. Click the Create Account button to proceed.</p>
      <h2>Step 2: Configure Settings</h2>
      <p>Once logged in, visit Settings from the top menu. Configure your notification preferences and time zone.</p>
      <h2>Step 3: Invite Team Members</h2>
      <p>Go to Team Management and enter the email addresses of colleagues you want to invite. They will receive an invitation link.</p>
    </main>
    <nav>
      <a href="/docs/advanced">Advanced Topics</a>
      <a href="/docs/api">API Reference</a>
      <a href="https://external.com">External Link</a>
    </nav>
  </body>
</html>
`;

const BASE_URL = 'https://docs.example.com/getting-started';

describe('Knowledge pipeline: extract → chunk → embed → store → search', () => {
  beforeEach(async () => {
    await vectorDB.clear();
    await documentDB.clear();
  });

  it('given HTML page when extracted then produces title and content', () => {
    const result = extractContent(SAMPLE_HTML, BASE_URL);

    // extractTitle prefers H1 text over <title> tag
    expect(result.title).toBe('Getting Started');
    expect(result.content).toContain('Getting Started');
    expect(result.content).toContain('Create an Account');
    expect(result.content.length).toBeGreaterThan(100);
  });

  it('given HTML page when extracting internal links then returns relative links resolved to same origin', () => {
    const links = extractLinks(SAMPLE_HTML, BASE_URL);

    expect(links).toContain('https://docs.example.com/docs/advanced');
    expect(links).toContain('https://docs.example.com/docs/api');
    expect(links.every((l) => l.startsWith('https://docs.example.com'))).toBe(true);
  });

  it('given long content when chunked then produces multiple non-empty chunks', () => {
    const { content } = extractContent(SAMPLE_HTML, BASE_URL);
    // _url is accepted by chunkText but not stored on Chunk (url is attached by embedder)
    const chunks = chunkText(content, BASE_URL);

    expect(chunks.length).toBeGreaterThan(0);
    chunks.forEach((chunk) => {
      expect(chunk.content.trim().length).toBeGreaterThan(0);
      expect(typeof chunk.index).toBe('number');
      expect(typeof chunk.startChar).toBe('number');
      expect(typeof chunk.endChar).toBe('number');
    });
  });

  it('given chunks when embedded then returns one vector per chunk', async () => {
    const { content } = extractContent(SAMPLE_HTML, BASE_URL);
    const chunks = chunkText(content, BASE_URL);
    const aiClient = makeAIStub();

    const vectors = await embedChunks(chunks, BASE_URL, 'Getting Started Guide', aiClient);

    expect(vectors).toHaveLength(chunks.length);
    vectors.forEach((v) => {
      expect(v.embedding).toHaveLength(8);
      expect(v.url).toBe(BASE_URL);
      expect(v.metadata.title).toBe('Getting Started Guide');
    });
  });

  it('given full pipeline when run then vectors stored in IndexedDB and searchable', async () => {
    const { content, title } = extractContent(SAMPLE_HTML, BASE_URL);
    const chunks = chunkText(content, BASE_URL);
    const aiClient = makeAIStub(8);

    const vectors = await embedChunks(chunks, BASE_URL, title, aiClient);
    await vectorDB.putBatch(vectors);

    const doc: CrawledDocument = {
      id: generateId(),
      url: BASE_URL,
      title,
      content,
      crawledAt: new Date().toISOString(),
      chunkCount: chunks.length,
    };
    await documentDB.put(doc);

    expect(await vectorDB.count()).toBe(vectors.length);
    expect(await documentDB.count()).toBe(1);
  });

  it('given stored vectors when searching then returns ranked results', async () => {
    const { content, title } = extractContent(SAMPLE_HTML, BASE_URL);
    const chunks = chunkText(content, BASE_URL);

    // Use a deterministic embedding: query vector is [1,0,…,0], only first chunk matches well
    let callCount = 0;
    const aiClient: AIClientInterface = {
      chat: vi.fn(),
      embed: vi.fn(async (texts: string[]) => {
        return texts.map(() => {
          callCount++;
          // Return a random-but-valid embedding
          return Array.from({ length: 4 }, (_, i) => (i === callCount % 4 ? 1 : 0));
        });
      }),
    };

    const vectors = await embedChunks(chunks, BASE_URL, title, aiClient);
    await vectorDB.putBatch(vectors);

    const queryEmbedding = [1, 0, 0, 0];
    const results = await search(queryEmbedding, 3);

    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(3);
    results.forEach((r) => {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    });

    // Results should be sorted descending by score
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it('given search results when formatted then produces human-readable string', async () => {
    const { content, title } = extractContent(SAMPLE_HTML, BASE_URL);
    const chunks = chunkText(content, BASE_URL);
    const aiClient = makeAIStub(4);
    const vectors = await embedChunks(chunks, BASE_URL, title, aiClient);
    await vectorDB.putBatch(vectors);

    const results = await search([1, 0, 0, 0], 2);
    const formatted = formatSearchResults(results);

    expect(typeof formatted).toBe('string');
    if (results.length > 0) {
      expect(formatted.length).toBeGreaterThan(0);
    }
  });

  it('given empty database when searching then returns empty array', async () => {
    const results = await search([0.1, 0.2, 0.3, 0.4], 5);
    expect(results).toEqual([]);
  });

  it('given thin content page when checking length then skips below threshold', () => {
    const thinHtml = '<html><body><p>Short.</p></body></html>';
    const { content } = extractContent(thinHtml, BASE_URL);
    expect(content.length).toBeLessThan(100);
  });

  it('given embed call failure when embedding then propagates error', async () => {
    const { content, title } = extractContent(SAMPLE_HTML, BASE_URL);
    const chunks = chunkText(content, BASE_URL);

    const failingClient: AIClientInterface = {
      chat: vi.fn(),
      embed: vi.fn().mockRejectedValue(new Error('API rate limited')),
    };

    await expect(embedChunks(chunks, BASE_URL, title, failingClient)).rejects.toThrow('API rate limited');
  });
});
