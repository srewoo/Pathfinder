import { createLogger } from '../../utils/logger';

const log = createLogger('embedding-cache');

interface CacheEntry {
  embedding: number[];
  /** Original text stored for collision detection. */
  text: string;
  accessedAt: number;
}

const MAX_ENTRIES = 1000;
const TTL_MS = 60 * 60 * 1000; // 1 hour

const cache = new Map<string, CacheEntry>();

/**
 * Collision-resistant cache key.
 * Combines a fast DJB2 hash with text length and boundary characters
 * to create a composite key. Two texts only collide if they have:
 *   - Same DJB2 hash (32-bit)
 *   - Same length
 *   - Same first 8 and last 8 characters
 * This is vastly more collision-resistant than a bare 32-bit hash.
 */
function cacheKey(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  const prefix = text.slice(0, 8);
  const suffix = text.slice(-8);
  return `${hash}:${text.length}:${prefix}:${suffix}`;
}

export function getCachedEmbedding(text: string): number[] | undefined {
  const key = cacheKey(text);
  const entry = cache.get(key);
  if (!entry) return undefined;

  // Verify the stored text matches to catch any residual hash collisions.
  if (entry.text !== text) {
    log.debug('Embedding cache collision detected — returning miss');
    return undefined;
  }

  if (Date.now() - entry.accessedAt > TTL_MS) {
    cache.delete(key);
    return undefined;
  }

  entry.accessedAt = Date.now();
  return entry.embedding;
}

export function setCachedEmbedding(text: string, embedding: number[]): void {
  if (cache.size >= MAX_ENTRIES) {
    evictOldest();
  }
  cache.set(cacheKey(text), { embedding, text, accessedAt: Date.now() });
}

/**
 * Given an array of texts, returns { results, uncachedTexts, uncachedIndices }
 * so the caller only needs to embed the uncached ones.
 */
export function partitionByCache(texts: string[]): {
  results: (number[] | null)[];
  uncachedTexts: string[];
  uncachedIndices: number[];
} {
  const results: (number[] | null)[] = [];
  const uncachedTexts: string[] = [];
  const uncachedIndices: number[] = [];

  for (let i = 0; i < texts.length; i++) {
    const cached = getCachedEmbedding(texts[i]);
    if (cached) {
      results.push(cached);
    } else {
      results.push(null);
      uncachedTexts.push(texts[i]);
      uncachedIndices.push(i);
    }
  }

  const hits = texts.length - uncachedTexts.length;
  if (hits > 0) {
    log.debug(`Embedding cache: ${hits}/${texts.length} hits`);
  }

  return { results, uncachedTexts, uncachedIndices };
}

export function mergeEmbeddings(
  partitioned: ReturnType<typeof partitionByCache>,
  freshEmbeddings: number[][],
  originalTexts: string[]
): number[][] {
  const { results, uncachedIndices } = partitioned;

  for (let i = 0; i < uncachedIndices.length; i++) {
    const idx = uncachedIndices[i];
    results[idx] = freshEmbeddings[i];
    setCachedEmbedding(originalTexts[idx], freshEmbeddings[i]);
  }

  return results as number[][];
}

function evictOldest(): void {
  let oldestKey: string | undefined;
  let oldestTime = Infinity;

  for (const [key, entry] of cache) {
    if (entry.accessedAt < oldestTime) {
      oldestTime = entry.accessedAt;
      oldestKey = key;
    }
  }

  if (oldestKey) cache.delete(oldestKey);
}

export function clearEmbeddingCache(): void {
  cache.clear();
}

export function getEmbeddingCacheStats(): { size: number; maxSize: number } {
  return { size: cache.size, maxSize: MAX_ENTRIES };
}
