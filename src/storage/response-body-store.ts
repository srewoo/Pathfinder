/**
 * Retained response bodies (ADR 001, phase 4) — debug only, opt-in, short-lived.
 *
 * Deliberately NOT stored on the `TestResult`. Three properties follow from that
 * choice, and none of them survive if bodies ride along with results:
 *
 *   - **Exports stay clean.** Every exporter reads results. Bodies in a separate store
 *     cannot leak into a JSON report, a JUnit file, or an exported graph by default —
 *     it takes new code to include them, which is the right amount of friction.
 *   - **A TTL is enforceable.** Results are kept indefinitely on purpose; retained
 *     payloads must not be. Reads purge anything older than the window.
 *   - **Deletion is one operation.** Turning the setting off can drop everything,
 *     rather than rewriting every stored result.
 */
import { createLogger } from '../utils/logger';

const log = createLogger('response-body-store');
const KEY = 'pathfinder.debug.responseBodies';

/** Retained bodies expire this long after capture. */
export const BODY_TTL_MS = 24 * 60 * 60 * 1000;
/** Bodies kept per run. */
export const MAX_BODIES_PER_RUN = 50;

export interface RetainedBody {
  url: string;
  method: string;
  status: number;
  /** Redacted JSON — never the raw payload. */
  body: string;
  redactedCount: number;
  truncated: boolean;
  capturedAt: number;
}

type BodyStore = Record<string, RetainedBody[]>;

async function readAll(): Promise<BodyStore> {
  try {
    const stored = await chrome.storage.local.get(KEY);
    return (stored[KEY] as BodyStore | undefined) ?? {};
  } catch (err) {
    log.debug('Could not read retained bodies', err);
    return {};
  }
}

/** Drop expired runs. Called on every read so nothing outlives the window unseen. */
function purge(store: BodyStore, now: number): { store: BodyStore; dropped: number } {
  let dropped = 0;
  const kept: BodyStore = {};
  for (const [runId, bodies] of Object.entries(store)) {
    const fresh = bodies.filter((b) => now - b.capturedAt < BODY_TTL_MS);
    dropped += bodies.length - fresh.length;
    if (fresh.length > 0) kept[runId] = fresh;
  }
  return { store: kept, dropped };
}

export async function retainBodies(
  runId: string,
  bodies: readonly RetainedBody[],
  now = Date.now()
): Promise<void> {
  if (bodies.length === 0) return;
  try {
    const { store, dropped } = purge(await readAll(), now);
    if (dropped > 0) log.info(`Purged ${dropped} retained body(ies) past the ${BODY_TTL_MS / 3_600_000}h window.`);
    const existing = store[runId] ?? [];
    store[runId] = [...existing, ...bodies].slice(0, MAX_BODIES_PER_RUN);
    await chrome.storage.local.set({ [KEY]: store });
    log.info(`Retained ${store[runId].length} redacted body(ies) for run ${runId} (debug).`);
  } catch (err) {
    log.warn('Could not retain response bodies', err);
  }
}

export async function getRetainedBodies(runId: string, now = Date.now()): Promise<RetainedBody[]> {
  const { store } = purge(await readAll(), now);
  return store[runId] ?? [];
}

export async function countRetainedBodies(now = Date.now()): Promise<number> {
  const { store } = purge(await readAll(), now);
  return Object.values(store).reduce((sum, bodies) => sum + bodies.length, 0);
}

/** Drop everything. Called when the setting is switched off. */
export async function clearRetainedBodies(): Promise<void> {
  try {
    await chrome.storage.local.remove(KEY);
    log.info('Cleared all retained response bodies.');
  } catch (err) {
    log.debug('Could not clear retained bodies', err);
  }
}
