/**
 * IndexedDB-backed JobStore (fix.md §4, §12).
 *
 * The important property is `commit`: the job record and the step's result are
 * written in ONE transaction. If the worker dies between them, neither landed,
 * and the resumed run re-runs a step it already has data for — which is safe
 * because steps are idempotent. The reverse (result written, cursor not) would
 * silently skip work.
 *
 * Reads are zod-validated (§12): a corrupt record fails loudly at load rather
 * than surfacing as a mystery `undefined` three modules later.
 */
import type { Job } from '../core/jobs/job-model';
import { JobSchema } from '../core/jobs/job-model';
import type { JobStore, StepResultRecord } from '../core/jobs/job-runner';
import { DB_NAME, DB_VERSION, STORES, runMigrations } from './migrations';
import { createLogger } from '../utils/logger';

const log = createLogger('job-db');

/** Jobs stuck in 'running' longer than this are assumed to be evicted workers. */
const STALE_RUNNING_MS = 60_000;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(new Error(`IndexedDB open failed: ${request.error?.message}`));
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const target = event.target as IDBOpenDBRequest;
      const tx = target.transaction;
      if (!tx) {
        reject(new Error('No versionchange transaction available'));
        return;
      }
      runMigrations(target.result, tx, event.oldVersion);
    };
  });
}

function parseJob(raw: unknown, context: string): Job | null {
  const parsed = JobSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  log.error(`Corrupt job record in ${context}: ${parsed.error.message}`);
  return null;
}

export const jobStore: JobStore = {
  async get(id) {
    const db = await openDB();
    try {
      const raw = await promisify<unknown>(
        db.transaction(STORES.jobs, 'readonly').objectStore(STORES.jobs).get(id)
      );
      return raw ? parseJob(raw, `get(${id})`) : null;
    } finally {
      db.close();
    }
  },

  /**
   * Single transaction over both stores. `commit` is the durability guarantee
   * the whole state machine rests on.
   */
  async commit(job, result) {
    const db = await openDB();
    try {
      await new Promise<void>((resolve, reject) => {
        const stores = result ? [STORES.jobs, STORES.runArtifacts] : [STORES.jobs];
        const tx = db.transaction(stores, 'readwrite');

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(new Error(`commit failed: ${tx.error?.message}`));
        tx.onabort = () => reject(new Error(`commit aborted: ${tx.error?.message}`));

        tx.objectStore(STORES.jobs).put(job);

        if (result) {
          tx.objectStore(STORES.runArtifacts).put({
            id: `${result.jobId}:${result.cursor}`,
            runId: result.jobId,
            kind: 'step-result',
            ...result,
          });
        }
      });
    } finally {
      db.close();
    }
  },

  /**
   * Claim the oldest job that can make progress.
   *
   * A job left in 'running' by an evicted worker must be reclaimable, or the
   * crawl wedges permanently — that is the exact scenario §4 exists to survive.
   * Staleness is judged by `updatedAt`, which every commit refreshes.
   */
  async claimResumable(now) {
    const db = await openDB();
    try {
      const raws = await promisify<unknown[]>(
        db.transaction(STORES.jobs, 'readonly').objectStore(STORES.jobs).getAll()
      );

      const candidates = raws
        .map((r) => parseJob(r, 'claimResumable'))
        .filter((j): j is Job => j !== null)
        .filter((j) => {
          if (j.state === 'queued') return true;
          if (j.state === 'running') return now - j.updatedAt > STALE_RUNNING_MS;
          return false;
        })
        .sort((a, b) => a.createdAt - b.createdAt);

      const claimed = candidates[0] ?? null;
      if (claimed && claimed.state === 'running') {
        log.warn(
          `Reclaiming job ${claimed.id} — stale for ${now - claimed.updatedAt}ms ` +
            `(worker was probably evicted mid-step)`
        );
      }
      return claimed;
    } finally {
      db.close();
    }
  },

  async list(state) {
    const db = await openDB();
    try {
      const raws = await promisify<unknown[]>(
        db.transaction(STORES.jobs, 'readonly').objectStore(STORES.jobs).getAll()
      );
      return raws
        .map((r) => parseJob(r, 'list'))
        .filter((j): j is Job => j !== null)
        .filter((j) => (state ? j.state === state : true))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    } finally {
      db.close();
    }
  },
};

function promisify<T>(request: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(new Error(request.error?.message ?? 'IDB request failed'));
  });
}

/**
 * In-memory JobStore for tests.
 *
 * Mirrors the real store's semantics including stale-running reclaim, so
 * resumption tests exercise the behaviour that matters rather than a
 * simplification of it.
 */
export function createInMemoryJobStore(seed: Job[] = []): JobStore & {
  results(): StepResultRecord[];
  all(): Job[];
  /** Simulate worker eviction: the job stays 'running' and goes stale. */
  evict(id: string, staleByMs?: number): void;
} {
  const jobs = new Map<string, Job>(seed.map((j) => [j.id, j]));
  const results: StepResultRecord[] = [];

  return {
    async get(id) {
      return jobs.get(id) ?? null;
    },
    async commit(job, result) {
      // Validate on write too — the real store round-trips through zod, and a
      // test store that accepts invalid records hides schema drift.
      jobs.set(job.id, JobSchema.parse(job));
      if (result) results.push(result);
    },
    async claimResumable(now) {
      return (
        [...jobs.values()]
          .filter((j) =>
            j.state === 'queued'
              ? true
              : j.state === 'running'
                ? now - j.updatedAt > STALE_RUNNING_MS
                : false
          )
          .sort((a, b) => a.createdAt - b.createdAt)[0] ?? null
      );
    },
    async list(state) {
      return [...jobs.values()].filter((j) => (state ? j.state === state : true));
    },
    results() {
      return results;
    },
    all() {
      return [...jobs.values()];
    },
    evict(id, staleByMs = STALE_RUNNING_MS + 1) {
      const j = jobs.get(id);
      if (!j) throw new Error(`No job ${id}`);
      jobs.set(id, { ...j, state: 'running', updatedAt: j.updatedAt - staleByMs });
    },
  };
}

export { STALE_RUNNING_MS };
