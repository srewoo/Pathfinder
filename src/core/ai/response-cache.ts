/**
 * In-memory response cache for chat completions.
 *
 * Keyed on the canonical hash of messages + options + model. Useful for
 * deterministic prompts (temperature ≤ 0.1) where re-running yields the same
 * response — common in plan validation, selector healing alternatives, and
 * structured extraction.
 *
 * Bypassed automatically when `temperature` is unset or > 0.1, since at higher
 * temperatures the response is meaningfully non-deterministic.
 */

import type { Message, ChatOptions } from './ai-client';

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface CacheEntry {
  value: string;
  expiresAt: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  evictions: number;
}

const store = new Map<string, CacheEntry>();
const stats: CacheStats = { hits: 0, misses: 0, size: 0, evictions: 0 };
let maxEntries = DEFAULT_MAX_ENTRIES;
let ttlMs = DEFAULT_TTL_MS;

export function configureResponseCache(opts: { maxEntries?: number; ttlMs?: number }): void {
  if (opts.maxEntries != null) maxEntries = Math.max(1, opts.maxEntries);
  if (opts.ttlMs != null) ttlMs = Math.max(0, opts.ttlMs);
}

export function isCacheable(options: ChatOptions | undefined): boolean {
  if (!options) return false;
  // Cache only when the caller explicitly opts into deterministic mode
  if (options.temperature == null) return false;
  return options.temperature <= 0.1;
}

export function buildCacheKey(model: string, messages: Message[], options: ChatOptions): string {
  const canonical = JSON.stringify({
    model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    temperature: options.temperature ?? null,
    maxTokens: options.maxTokens ?? null,
    jsonMode: options.jsonMode ?? false,
  });
  return fnv1a32(canonical);
}

export function getCached(key: string): string | undefined {
  const entry = store.get(key);
  if (!entry) {
    stats.misses++;
    return undefined;
  }
  if (entry.expiresAt < Date.now()) {
    store.delete(key);
    stats.evictions++;
    stats.size = store.size;
    stats.misses++;
    return undefined;
  }
  // LRU touch: re-insert to move to tail
  store.delete(key);
  store.set(key, entry);
  stats.hits++;
  return entry.value;
}

export function setCached(key: string, value: string): void {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
  if (store.size > maxEntries) {
    // Evict oldest (insertion order)
    const oldestKey = store.keys().next().value as string | undefined;
    if (oldestKey) {
      store.delete(oldestKey);
      stats.evictions++;
    }
  }
  stats.size = store.size;
}

export function clearResponseCache(): void {
  store.clear();
  stats.size = 0;
}

export function getCacheStats(): CacheStats {
  return { ...stats };
}

export function resetCacheStats(): void {
  stats.hits = 0;
  stats.misses = 0;
  stats.evictions = 0;
  stats.size = store.size;
}

function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
