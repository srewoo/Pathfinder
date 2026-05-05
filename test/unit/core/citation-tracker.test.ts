import { describe, it, expect } from 'vitest';
import {
  buildCitations, formatCitedResults, extractCitedIds, resolveCitedIds,
} from '../../../src/core/knowledge/citation-tracker';
import type { SearchResult } from '../../../src/core/knowledge/vector-search';

const mkResult = (url: string, content: string, section = 'General', score = 0.8): SearchResult => ({
  score,
  record: {
    id: url,
    url,
    chunkIndex: 0,
    content,
    embedding: new Float32Array([0.1, 0.2, 0.3]),
    metadata: { section, title: 't' },
  } as never,
});

describe('buildCitations', () => {
  it('given results when building then assigns sequential doc-N IDs', () => {
    const cites = buildCitations([mkResult('a.com', 'aaaa'), mkResult('b.com', 'bbbb')]);
    expect(cites.map((c) => c.id)).toEqual(['doc-1', 'doc-2']);
  });

  it('given long content when building then truncates excerpt', () => {
    const long = 'x'.repeat(500);
    const [c] = buildCitations([mkResult('a.com', long)]);
    expect(c.excerpt.length).toBeLessThanOrEqual(200);
    expect(c.excerpt.endsWith('…')).toBe(true);
  });

  it('given missing section when building then defaults to General', () => {
    const [c] = buildCitations([mkResult('a.com', 'x', '')]);
    expect(c.section).toBe('General');
  });
});

describe('formatCitedResults', () => {
  it('given results when formatting then prepends [doc-N] tags', () => {
    const { text } = formatCitedResults([mkResult('a.com', 'hello'), mkResult('b.com', 'world')]);
    expect(text).toContain('[doc-1]');
    expect(text).toContain('[doc-2]');
    expect(text).toContain('hello');
    expect(text).toContain('world');
  });

  it('given empty results when formatting then returns sentinel', () => {
    expect(formatCitedResults([])).toEqual({
      text: 'No relevant documentation found.',
      citations: [],
    });
  });
});

describe('extractCitedIds', () => {
  it('given text with one citation when extracting then returns id', () => {
    expect(extractCitedIds('see [doc-1] for details')).toEqual(['doc-1']);
  });

  it('given multiple citations when extracting then preserves order and dedupes', () => {
    expect(extractCitedIds('[doc-2] then [doc-1] then [doc-2]')).toEqual(['doc-2', 'doc-1']);
  });

  it('given no citations when extracting then empty array', () => {
    expect(extractCitedIds('just regular text')).toEqual([]);
  });
});

describe('resolveCitedIds', () => {
  it('given valid ids when resolving then returns matching citations', () => {
    const cites = buildCitations([mkResult('a.com', 'x'), mkResult('b.com', 'y')]);
    const resolved = resolveCitedIds(['doc-2', 'doc-1'], cites);
    expect(resolved.map((c) => c.url)).toEqual(['b.com', 'a.com']);
  });

  it('given hallucinated id when resolving then drops it', () => {
    const cites = buildCitations([mkResult('a.com', 'x')]);
    expect(resolveCitedIds(['doc-99'], cites)).toEqual([]);
  });
});
