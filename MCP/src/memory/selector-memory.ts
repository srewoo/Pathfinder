import { memoryStore } from './memory-store.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('selector-memory');

export interface SelectorHeal {
  originalSelector: string;
  healedSelector: string;
  method: string;
  successCount: number;
  lastUsed: string;
}

function makeKey(pageUrl: string, originalSelector: string): string {
  // Normalize: strip origin, keep path + selector
  let path: string;
  try { path = new URL(pageUrl).pathname; } catch { path = pageUrl; }
  return `heal:${path}::${originalSelector}`;
}

export async function lookupHealedSelector(pageUrl: string, originalSelector: string): Promise<SelectorHeal | undefined> {
  const key = makeKey(pageUrl, originalSelector);
  const entry = await memoryStore.get(key);
  if (!entry) return undefined;

  const heal = entry.value as SelectorHeal;
  log.debug(`Memory hit for selector ${originalSelector} on ${pageUrl} → ${heal.healedSelector} (used ${heal.successCount}x)`);
  return heal;
}

export async function recordSuccessfulHeal(
  pageUrl: string,
  originalSelector: string,
  healedSelector: string,
  method: string
): Promise<void> {
  const key = makeKey(pageUrl, originalSelector);
  const existing = await memoryStore.get(key);

  const heal: SelectorHeal = {
    originalSelector,
    healedSelector,
    method,
    successCount: existing ? ((existing.value as SelectorHeal).successCount ?? 0) + 1 : 1,
    lastUsed: new Date().toISOString(),
  };

  await memoryStore.set(key, heal, 'selector_heal');
  log.info(`Remembered heal: ${originalSelector} → ${healedSelector} (${method})`);
}

export async function recordHealFailure(
  pageUrl: string,
  originalSelector: string
): Promise<void> {
  const key = makeKey(pageUrl, originalSelector);
  const existing = await memoryStore.get(key);

  // If there was a previous successful heal that no longer works, clear it
  if (existing) {
    await memoryStore.delete(key);
    log.info(`Cleared stale heal memory for ${originalSelector}`);
  }
}
