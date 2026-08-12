/**
 * Baseline persistence, keyed by origin.
 *
 * `chrome.storage.local` rather than IndexedDB, deviating from ADR 001's sketch for
 * the reason stated in `checkpoint-storage.ts`: IndexedDB is reserved for entities,
 * and a baseline is a small, single-valued, frequently-overwritten record per origin.
 * Choosing it here also avoids a schema migration for a store with one row per app.
 *
 * Best-effort throughout. Losing a baseline degrades the diff to "no baseline yet";
 * failing a run over it would be the wrong trade.
 */
import type { ApiBaseline } from '../core/analysis/api-baseline';
import { createLogger } from '../utils/logger';

const log = createLogger('api-baseline-store');
const KEY = 'pathfinder.api.baselines';

type BaselineMap = Record<string, ApiBaseline>;

async function readAll(): Promise<BaselineMap> {
  try {
    const stored = await chrome.storage.local.get(KEY);
    return (stored[KEY] as BaselineMap | undefined) ?? {};
  } catch (err) {
    log.debug('Could not read API baselines', err);
    return {};
  }
}

export async function saveBaseline(baseline: ApiBaseline): Promise<void> {
  try {
    const all = await readAll();
    all[baseline.origin] = baseline;
    await chrome.storage.local.set({ [KEY]: all });
    log.info(
      `Baseline saved for ${baseline.origin}: ${Object.keys(baseline.endpoints).length} endpoint(s)`
    );
  } catch (err) {
    log.warn('Could not save API baseline', err);
  }
}

export async function loadBaseline(origin: string): Promise<ApiBaseline | undefined> {
  const all = await readAll();
  const found = all[origin];
  // A baseline from an older shape is ignored rather than migrated: comparing against
  // a record we cannot interpret would produce confident nonsense.
  if (found && found.version !== 1) return undefined;
  return found;
}

export async function listBaselines(): Promise<ApiBaseline[]> {
  return Object.values(await readAll()).sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
}

export async function clearBaseline(origin: string): Promise<void> {
  try {
    const all = await readAll();
    delete all[origin];
    await chrome.storage.local.set({ [KEY]: all });
  } catch (err) {
    log.debug('Could not clear API baseline', err);
  }
}
