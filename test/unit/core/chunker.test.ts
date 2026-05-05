import { describe, it, expect } from 'vitest';
import { chunkText, estimateTokens } from '../../../src/core/knowledge/chunker';

describe('chunkText', () => {
  const url = 'https://example.com/docs';

  it('given empty string when chunked then returns empty array', () => {
    const result = chunkText('', url);
    expect(result).toEqual([]);
  });

  it('given null-like empty content when chunked then returns empty array', () => {
    const result = chunkText('   ', url);
    expect(result).toEqual([]);
  });

  it('given short text when chunked then returns single chunk', () => {
    const text = 'This is a short paragraph about the product.';
    const result = chunkText(text, url);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe(text.trim());
    expect(result[0].index).toBe(0);
  });

  it('given text with sections when chunked then splits by headings', () => {
    const text = `## Introduction
This is the intro section with content.

## Getting Started
This section describes how to get started.

## Advanced Usage
Advanced features are described here.`;

    const result = chunkText(text, url);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.every((c) => c.content.length > 0)).toBe(true);
  });

  it('given very long text when chunked then creates multiple chunks', () => {
    // Use diverse content to avoid deduplication by Jaccard similarity
    const paragraph = Array.from({ length: 100 }, (_, i) =>
      `Paragraph ${i}: This section covers topic number ${i} with unique details about feature ${i * 7}. `
    ).join('');
    const result = chunkText(paragraph, url);
    expect(result.length).toBeGreaterThan(1);
  });

  it('given long text when chunked then chunks have sequential indices', () => {
    const text = 'Word '.repeat(1000);
    const result = chunkText(text, url);
    result.forEach((chunk, i) => {
      expect(chunk.index).toBe(i);
    });
  });

  it('given multiple chunks when chunked then each chunk has content', () => {
    const text = 'Sentence. '.repeat(500);
    const result = chunkText(text, url);
    result.forEach((chunk) => {
      expect(chunk.content.length).toBeGreaterThan(0);
    });
  });
});

describe('estimateTokens', () => {
  it('given empty string when estimated then returns 0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('given four characters when estimated then returns 1 token', () => {
    expect(estimateTokens('test')).toBe(1);
  });

  it('given 100 characters when estimated then returns ~25 tokens', () => {
    const text = 'a'.repeat(100);
    expect(estimateTokens(text)).toBe(25);
  });

  it('given typical paragraph when estimated then returns reasonable token count', () => {
    const text = 'The quick brown fox jumps over the lazy dog. This is a typical sentence.';
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(10);
    expect(tokens).toBeLessThan(30);
  });
});
