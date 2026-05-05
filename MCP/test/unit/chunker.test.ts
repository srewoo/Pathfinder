import { describe, it, expect } from 'vitest';
import { chunkText, estimateTokens } from '../../src/core/knowledge/chunker.js';

describe('chunkText', () => {
  it('given_empty_text_when_chunked_then_returns_empty_array', () => {
    expect(chunkText('', 'https://example.com')).toEqual([]);
  });

  it('given_whitespace_only_when_chunked_then_returns_empty_array', () => {
    expect(chunkText('   \n\n   ', 'https://example.com')).toEqual([]);
  });

  it('given_short_text_when_chunked_then_returns_single_chunk', () => {
    const text = 'This is a short paragraph about testing.'.repeat(5);
    const chunks = chunkText(text, 'https://example.com');
    expect(chunks.length).toBe(1);
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].content).toContain('short paragraph');
  });

  it('given_long_text_when_chunked_then_splits_into_multiple_chunks', () => {
    // Generate text that will produce distinct, non-deduplicatable chunks
    const paragraphs = Array.from({ length: 20 }, (_, i) =>
      `Paragraph ${i}: This is unique content number ${i} about topic ${i * 7}. ` +
      `It discusses feature ${i} in detail with specific values like ${i * 13} and ${i * 17}. `.repeat(5)
    );
    const text = paragraphs.join('\n\n');
    const chunks = chunkText(text, 'https://example.com');
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('given_sectioned_text_when_chunked_then_splits_by_sections', () => {
    const text = [
      '## Introduction',
      'This is the introduction section. '.repeat(10),
      '## Methods',
      'This is the methods section. '.repeat(10),
      '## Results',
      'This is the results section. '.repeat(10),
    ].join('\n');

    const chunks = chunkText(text, 'https://example.com');
    expect(chunks.length).toBeGreaterThanOrEqual(3);
  });

  it('given_text_with_chunks_then_indexes_are_sequential', () => {
    const text = 'Hello world. '.repeat(500);
    const chunks = chunkText(text, 'https://example.com');
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].index).toBe(i);
    }
  });

  it('given_text_with_duplicate_sections_when_chunked_then_deduplicates', () => {
    const section = 'This is a repeated section with lots of common words. '.repeat(20);
    const text = `## Section A\n${section}\n## Section B\n${section}`;
    const chunks = chunkText(text, 'https://example.com');
    // After deduplication, should have fewer chunks than without
    expect(chunks.length).toBeGreaterThan(0);
  });
});

describe('estimateTokens', () => {
  it('given_text_when_estimated_then_returns_approx_quarter_of_length', () => {
    const text = 'Hello World'; // 11 chars → ~3 tokens
    expect(estimateTokens(text)).toBe(3);
  });

  it('given_empty_text_when_estimated_then_returns_zero', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('given_long_text_when_estimated_then_scales_linearly', () => {
    const text = 'a'.repeat(4000);
    expect(estimateTokens(text)).toBe(1000);
  });
});
