import { describe, it, expect, beforeEach } from 'vitest';
import {
  getCachedEmbedding,
  setCachedEmbedding,
  partitionByCache,
  mergeEmbeddings,
  clearEmbeddingCache,
  getEmbeddingCacheStats,
} from '../../src/core/ai/embedding-cache.js';

describe('embedding-cache', () => {
  beforeEach(() => {
    clearEmbeddingCache();
  });

  it('given_uncached_text_when_looked_up_then_returns_undefined', () => {
    expect(getCachedEmbedding('hello world')).toBeUndefined();
  });

  it('given_cached_text_when_looked_up_then_returns_embedding', () => {
    const embedding = [0.1, 0.2, 0.3];
    setCachedEmbedding('hello world', embedding);
    expect(getCachedEmbedding('hello world')).toEqual(embedding);
  });

  it('given_different_texts_when_cached_then_returns_correct_embeddings', () => {
    setCachedEmbedding('text a', [1, 2, 3]);
    setCachedEmbedding('text b', [4, 5, 6]);
    expect(getCachedEmbedding('text a')).toEqual([1, 2, 3]);
    expect(getCachedEmbedding('text b')).toEqual([4, 5, 6]);
  });

  it('given_cache_cleared_when_looked_up_then_returns_undefined', () => {
    setCachedEmbedding('hello', [1, 2, 3]);
    clearEmbeddingCache();
    expect(getCachedEmbedding('hello')).toBeUndefined();
  });

  it('given_cache_stats_when_queried_then_returns_size', () => {
    setCachedEmbedding('a', [1]);
    setCachedEmbedding('b', [2]);
    const stats = getEmbeddingCacheStats();
    expect(stats.size).toBe(2);
    expect(stats.maxSize).toBe(1000);
  });
});

describe('partitionByCache', () => {
  beforeEach(() => {
    clearEmbeddingCache();
  });

  it('given_all_uncached_when_partitioned_then_all_uncached', () => {
    const result = partitionByCache(['a', 'b', 'c']);
    expect(result.uncachedTexts).toEqual(['a', 'b', 'c']);
    expect(result.uncachedIndices).toEqual([0, 1, 2]);
    expect(result.results).toEqual([null, null, null]);
  });

  it('given_some_cached_when_partitioned_then_splits_correctly', () => {
    setCachedEmbedding('b', [4, 5, 6]);
    const result = partitionByCache(['a', 'b', 'c']);
    expect(result.uncachedTexts).toEqual(['a', 'c']);
    expect(result.uncachedIndices).toEqual([0, 2]);
    expect(result.results[1]).toEqual([4, 5, 6]);
  });

  it('given_all_cached_when_partitioned_then_none_uncached', () => {
    setCachedEmbedding('x', [1]);
    setCachedEmbedding('y', [2]);
    const result = partitionByCache(['x', 'y']);
    expect(result.uncachedTexts).toEqual([]);
    expect(result.uncachedIndices).toEqual([]);
  });
});

describe('mergeEmbeddings', () => {
  beforeEach(() => {
    clearEmbeddingCache();
  });

  it('given_partitioned_data_and_fresh_embeddings_when_merged_then_fills_gaps', () => {
    setCachedEmbedding('b', [4, 5, 6]);
    const texts = ['a', 'b', 'c'];
    const partitioned = partitionByCache(texts);
    const fresh = [[1, 2, 3], [7, 8, 9]]; // embeddings for 'a' and 'c'
    const merged = mergeEmbeddings(partitioned, fresh, texts);

    expect(merged).toEqual([
      [1, 2, 3], // a
      [4, 5, 6], // b (from cache)
      [7, 8, 9], // c
    ]);

    // Verify new embeddings were cached
    expect(getCachedEmbedding('a')).toEqual([1, 2, 3]);
    expect(getCachedEmbedding('c')).toEqual([7, 8, 9]);
  });
});
