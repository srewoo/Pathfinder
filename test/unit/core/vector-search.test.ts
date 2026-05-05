import { describe, it, expect, vi, beforeEach } from 'vitest';
import { search, formatSearchResults, invalidateVectorCache } from '../../../src/core/knowledge/vector-search';
import type { VectorRecord } from '../../../src/storage/schemas';

vi.mock('../../../src/storage/indexed-db', () => ({
  vectorDB: {
    getAll: vi.fn(),
  },
}));

const { vectorDB } = await import('../../../src/storage/indexed-db');

function makeVector(id: string, content: string, embedding: number[]): VectorRecord {
  return {
    id,
    content,
    url: `https://example.com/${id}`,
    embedding,
    metadata: {
      title: 'Test',
      section: 'General',
      crawledAt: new Date().toISOString(),
      chunkIndex: 0,
      totalChunks: 1,
    },
  };
}

describe('search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateVectorCache();
  });

  it('given empty vector store when searched then returns empty results', async () => {
    vi.mocked(vectorDB.getAll).mockResolvedValue([]);
    const result = await search([1, 0, 0]);
    expect(result).toEqual([]);
  });

  it('given identical vector when searched then returns high score', async () => {
    const embedding = [1, 0, 0];
    vi.mocked(vectorDB.getAll).mockResolvedValue([
      makeVector('doc1', 'Exact match content', embedding),
    ]);

    // search() uses semantic-only scoring with weight 0.7, so max score is 0.7
    const results = await search(embedding, 1, 0);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBeGreaterThan(0.5);
  });

  it('given opposite vector when searched then returns no results above threshold', async () => {
    vi.mocked(vectorDB.getAll).mockResolvedValue([
      makeVector('doc1', 'Opposite content', [-1, 0, 0]),
    ]);

    // Opposite vectors have negative cosine — filtered out by pre-filter
    const results = await search([1, 0, 0], 1, 0);
    // With 0 minScore, pre-filter is at 0 * 0.5 = 0, so negative cosine is excluded
    expect(results).toHaveLength(0);
  });

  it('given multiple vectors when searched then returns topK sorted by score', async () => {
    vi.mocked(vectorDB.getAll).mockResolvedValue([
      makeVector('doc1', 'Low relevance', [0, 1, 0]),
      makeVector('doc2', 'High relevance', [1, 0, 0]),
      makeVector('doc3', 'Medium relevance', [0.7, 0.7, 0]),
    ]);

    const results = await search([1, 0, 0], 2, 0);
    expect(results).toHaveLength(2);
    expect(results[0].record.id).toBe('doc2');
  });

  it('given minScore filter when searched then excludes low-scoring results', async () => {
    vi.mocked(vectorDB.getAll).mockResolvedValue([
      makeVector('doc1', 'Irrelevant', [0, 0, 1]),
      makeVector('doc2', 'Relevant', [1, 0, 0]),
    ]);

    const results = await search([1, 0, 0], 5, 0.5);
    expect(results.every((r) => r.score >= 0.5)).toBe(true);
  });

  it('given mismatched dimension vectors when searched then returns 0 semantic score', async () => {
    vi.mocked(vectorDB.getAll).mockResolvedValue([
      makeVector('doc1', 'Content', [1, 0]),
    ]);

    // Dimension mismatch (2 vs 3) — >10% difference returns 0 cosine
    // With minScore > 0, the result is filtered out
    const results = await search([1, 0, 0], 5, 0.1);
    expect(results).toHaveLength(0);
  });
});

describe('formatSearchResults', () => {
  it('given empty results when formatted then returns no results message', () => {
    const result = formatSearchResults([]);
    expect(result).toBe('No relevant documentation found.');
  });

  it('given one result when formatted then includes content and url', () => {
    const record = makeVector('doc1', 'Important content here', [1, 0, 0]);
    const result = formatSearchResults([{ record, score: 0.9 }]);
    expect(result).toContain('Important content here');
    expect(result).toContain('example.com');
  });

  it('given multiple results when formatted then numbers each result', () => {
    const records = [
      { record: makeVector('d1', 'Content one', [1, 0, 0]), score: 0.9 },
      { record: makeVector('d2', 'Content two', [0, 1, 0]), score: 0.8 },
    ];
    const result = formatSearchResults(records);
    expect(result).toContain('[1]');
    expect(result).toContain('[2]');
  });
});
