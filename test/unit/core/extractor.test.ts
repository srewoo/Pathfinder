import { describe, it, expect } from 'vitest';
import { extractContent, extractLinks } from '../../../src/core/knowledge/extractor';

describe('extractContent', () => {
  const url = 'https://docs.example.com/guide';

  it('given empty HTML when extracted then returns empty content', () => {
    const result = extractContent('<html><body></body></html>', url);
    expect(result.url).toBe(url);
    expect(result.content).toBe('');
  });

  it('given HTML with title when extracted then returns correct title', () => {
    const html = '<html><head><title>Getting Started | Docs</title></head><body><p>Content</p></body></html>';
    const result = extractContent(html, url);
    expect(result.title).toBe('Getting Started');
  });

  it('given HTML with h1 when extracted then uses h1 as title', () => {
    const html = '<html><body><h1>Installation Guide</h1><p>Content here</p></body></html>';
    const result = extractContent(html, url);
    expect(result.title).toBe('Installation Guide');
  });

  it('given HTML with paragraphs when extracted then includes text content', () => {
    const html = `<html><body>
      <main>
        <h1>Guide</h1>
        <p>This is the main content of the page.</p>
        <p>Second paragraph with information.</p>
      </main>
    </body></html>`;
    const result = extractContent(html, url);
    expect(result.content).toContain('main content');
    expect(result.content).toContain('Second paragraph');
  });

  it('given HTML with nav and footer when extracted then excludes navigation', () => {
    const html = `<html><body>
      <nav>Home | About | Contact</nav>
      <main><p>Actual content.</p></main>
      <footer>Copyright 2024</footer>
    </body></html>`;
    const result = extractContent(html, url);
    expect(result.content).not.toContain('Home | About');
    expect(result.content).not.toContain('Copyright');
  });

  it('given HTML with script tags when extracted then excludes scripts', () => {
    const html = `<html><body>
      <p>Valid content</p>
      <script>malicious.code()</script>
    </body></html>`;
    const result = extractContent(html, url);
    expect(result.content).not.toContain('malicious.code');
  });

  it('given HTML with headings when extracted then returns sections', () => {
    const html = `<html><body>
      <h2>Section One</h2><p>Content</p>
      <h2>Section Two</h2><p>Content</p>
    </body></html>`;
    const result = extractContent(html, url);
    expect(result.sections.length).toBeGreaterThanOrEqual(2);
  });
});

describe('extractLinks', () => {
  const baseUrl = 'https://docs.example.com/guide';

  it('given HTML with no links when extracted then returns empty array', () => {
    const html = '<html><body><p>No links here</p></body></html>';
    const result = extractLinks(html, baseUrl);
    expect(result).toEqual([]);
  });

  it('given HTML with internal links when extracted then returns those links', () => {
    const html = `<html><body>
      <a href="/getting-started">Getting Started</a>
      <a href="/api-reference">API Reference</a>
    </body></html>`;
    const result = extractLinks(html, baseUrl);
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((l) => l.includes('docs.example.com'))).toBe(true);
  });

  it('given HTML with external links when extracted then excludes external links', () => {
    const html = `<html><body>
      <a href="https://external.com/page">External</a>
    </body></html>`;
    const result = extractLinks(html, baseUrl);
    expect(result).toEqual([]);
  });

  it('given HTML with duplicate links when extracted then deduplicates', () => {
    const html = `<html><body>
      <a href="/page">Link</a>
      <a href="/page">Duplicate</a>
    </body></html>`;
    const result = extractLinks(html, baseUrl);
    expect(result.length).toBe(1);
  });

  it('given HTML with media file links when extracted then excludes media', () => {
    const html = `<html><body>
      <a href="/doc.pdf">PDF</a>
      <a href="/image.jpg">Image</a>
      <a href="/valid-page">Valid</a>
    </body></html>`;
    const result = extractLinks(html, baseUrl);
    expect(result.some((l) => l.includes('.pdf'))).toBe(false);
    expect(result.some((l) => l.includes('.jpg'))).toBe(false);
  });
});
