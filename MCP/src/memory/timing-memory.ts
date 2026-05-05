import { memoryStore } from './memory-store.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('timing-memory');

export interface TimingProfile {
  avgDurationMs: number;
  maxDurationMs: number;
  samples: number;
  lastUpdated: string;
}

function makeKey(pageUrl: string): string {
  let path: string;
  try { path = new URL(pageUrl).pathname; } catch { path = pageUrl; }
  return `timing:${path}`;
}

export async function getTimingProfile(pageUrl: string): Promise<TimingProfile | undefined> {
  const key = makeKey(pageUrl);
  const entry = await memoryStore.get(key);
  if (!entry) return undefined;
  return entry.value as TimingProfile;
}

export async function recordStepTiming(pageUrl: string, durationMs: number): Promise<void> {
  const key = makeKey(pageUrl);
  const existing = await memoryStore.get(key);

  let profile: TimingProfile;
  if (existing) {
    const prev = existing.value as TimingProfile;
    const newSamples = prev.samples + 1;
    profile = {
      avgDurationMs: Math.round((prev.avgDurationMs * prev.samples + durationMs) / newSamples),
      maxDurationMs: Math.max(prev.maxDurationMs, durationMs),
      samples: newSamples,
      lastUpdated: new Date().toISOString(),
    };
  } else {
    profile = {
      avgDurationMs: durationMs,
      maxDurationMs: durationMs,
      samples: 1,
      lastUpdated: new Date().toISOString(),
    };
  }

  await memoryStore.set(key, profile, 'timing_profile');
}

/**
 * Suggest a timeout multiplier based on historical timing data.
 * Returns 1.0 if no data exists, or a multiplier if the page is known-slow.
 */
export async function suggestTimeoutMultiplier(pageUrl: string, defaultTimeoutMs: number): Promise<number> {
  const profile = await getTimingProfile(pageUrl);
  if (!profile || profile.samples < 3) return 1.0;

  // If average duration is > 60% of the default timeout, suggest a multiplier
  const ratio = profile.avgDurationMs / defaultTimeoutMs;
  if (ratio > 0.6) {
    const multiplier = Math.min(3.0, Math.ceil(ratio * 2 * 10) / 10);
    log.debug(`Page ${pageUrl} is slow (avg ${profile.avgDurationMs}ms) — suggesting ${multiplier}x timeout`);
    return multiplier;
  }

  return 1.0;
}
