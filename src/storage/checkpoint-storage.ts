/**
 * Checkpoint persistence for exploration.
 *
 * Lives in `src/storage/` rather than `src/core/explorer/`: it uses
 * `chrome.storage`, and §2 forbids `chrome.*` inside core. The §2 lint rule caught
 * this on the first run — the storage layer is where browser persistence belongs,
 * so this is a placement fix, not an exemption.
 *
 * Kept in `chrome.storage.local` rather than IndexedDB: a checkpoint is a small,
 * single-valued, frequently-overwritten record, and `chrome.storage` is the right
 * home for exactly that (fix.md §12 reserves IndexedDB for entities).
 *
 * Every function here is best-effort. A failed checkpoint must never fail a crawl
 * — losing resumability is a degradation, losing the run is not acceptable.
 */
import type { ExplorationCheckpoint } from '../core/explorer/exploration-checkpoint';
import { createLogger } from '../utils/logger';

const log = createLogger('checkpoint-store');
const KEY = 'pathfinder.exploration.checkpoint';

export async function persistCheckpoint(checkpoint: ExplorationCheckpoint): Promise<void> {
  try {
    await chrome.storage.local.set({ [KEY]: checkpoint });
  } catch (err) {
    log.debug('Could not persist exploration checkpoint', err);
  }
}

export async function loadCheckpoint(): Promise<unknown> {
  try {
    const stored = await chrome.storage.local.get(KEY);
    return stored[KEY];
  } catch (err) {
    log.debug('Could not read exploration checkpoint', err);
    return undefined;
  }
}

export async function clearCheckpoint(): Promise<void> {
  try {
    await chrome.storage.local.remove(KEY);
  } catch (err) {
    log.debug('Could not clear exploration checkpoint', err);
  }
}
