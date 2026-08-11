/**
 * Explicit forward-migration chain (fix.md §12).
 *
 * Previously the schema was implied by a pile of `if (!contains(store))` guards
 * inside one `onupgradeneeded`, which works for adding stores and quietly fails
 * for anything else — there was no way to backfill a record, rename a field, or
 * know which version a user was coming from.
 *
 * Here each migration is a numbered, named step. `onupgradeneeded` runs every
 * step from `oldVersion + 1` to `DB_VERSION`, in order. Migrations are
 * forward-only and additive: never modify a shipped migration, add a new one.
 *
 * The interaction-graph shape *will* change, and users will have existing data.
 */
import { createLogger } from '../utils/logger';

const log = createLogger('migrations');

export const DB_NAME = 'pathfinder_db';

/** Bump this when adding a migration. Must equal the highest `version` below. */
export const DB_VERSION = 3;

export const STORES = {
  vectors: 'vectors',
  documents: 'documents',
  flows: 'flows',
  testCases: 'test_cases',
  testResults: 'test_results',
  executionPlans: 'execution_plans',
  interactionGraph: 'interaction_graph',
  testRuns: 'test_runs',
  graphSnapshots: 'graph_snapshots',
  /** v3 — durable job state machine (§4). */
  jobs: 'jobs',
  /** v3 — per-run artifacts: heal log, mutation ledger, testability report (§11). */
  runArtifacts: 'run_artifacts',
} as const;

export interface Migration {
  version: number;
  name: string;
  /**
   * Runs inside the versionchange transaction. Must be synchronous — IndexedDB
   * commits a versionchange transaction as soon as the microtask queue drains,
   * so any `await` here silently aborts it.
   */
  up: (db: IDBDatabase, tx: IDBTransaction) => void;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial-stores',
    up(db) {
      if (!db.objectStoreNames.contains(STORES.vectors)) {
        const s = db.createObjectStore(STORES.vectors, { keyPath: 'id' });
        s.createIndex('url', 'url', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.documents)) {
        const s = db.createObjectStore(STORES.documents, { keyPath: 'id' });
        s.createIndex('url', 'url', { unique: true });
      }
      if (!db.objectStoreNames.contains(STORES.flows)) {
        db.createObjectStore(STORES.flows, { keyPath: 'flowId' });
      }
      if (!db.objectStoreNames.contains(STORES.testCases)) {
        const s = db.createObjectStore(STORES.testCases, { keyPath: 'id' });
        s.createIndex('sourceFlowId', 'sourceFlowId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.testResults)) {
        const s = db.createObjectStore(STORES.testResults, { keyPath: 'id' });
        s.createIndex('testCaseId', 'testCaseId', { unique: false });
        s.createIndex('runId', 'runId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.executionPlans)) {
        const s = db.createObjectStore(STORES.executionPlans, { keyPath: 'id' });
        s.createIndex('testCaseHash', 'testCaseHash', { unique: false });
        s.createIndex('testCaseId', 'testCaseId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.interactionGraph)) {
        db.createObjectStore(STORES.interactionGraph, { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORES.testRuns)) {
        db.createObjectStore(STORES.testRuns, { keyPath: 'id' });
      }
    },
  },

  {
    version: 2,
    name: 'graph-snapshots-and-plan-index',
    up(db, tx) {
      if (!db.objectStoreNames.contains(STORES.graphSnapshots)) {
        const s = db.createObjectStore(STORES.graphSnapshots, { keyPath: 'id' });
        s.createIndex('savedAt', 'savedAt', { unique: false });
      }
      // v1 shipped execution_plans without a testCaseId index.
      if (db.objectStoreNames.contains(STORES.executionPlans)) {
        const s = tx.objectStore(STORES.executionPlans);
        if (!s.indexNames.contains('testCaseId')) {
          s.createIndex('testCaseId', 'testCaseId', { unique: false });
        }
      }
    },
  },

  {
    version: 3,
    name: 'durable-jobs-and-run-artifacts',
    up(db) {
      if (!db.objectStoreNames.contains(STORES.jobs)) {
        const s = db.createObjectStore(STORES.jobs, { keyPath: 'id' });
        // The pump's hot query: "is there a job to resume?"
        s.createIndex('state', 'state', { unique: false });
        s.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.runArtifacts)) {
        const s = db.createObjectStore(STORES.runArtifacts, { keyPath: 'id' });
        s.createIndex('runId', 'runId', { unique: false });
        s.createIndex('kind', 'kind', { unique: false });
      }
    },
  },
];

/**
 * Run every migration newer than `oldVersion`.
 *
 * A migration that throws aborts the whole versionchange transaction, leaving
 * the database at its previous version. That is the correct outcome — a
 * half-migrated database is worse than an un-migrated one.
 */
export function runMigrations(db: IDBDatabase, tx: IDBTransaction, oldVersion: number): void {
  // Bound by the version actually being opened, not just by oldVersion.
  // `db.version` is the target of this upgrade; running past it would create
  // stores from a future schema that the opening code does not expect to exist.
  const targetVersion = db.version || DB_VERSION;

  const pending = MIGRATIONS.filter(
    (m) => m.version > oldVersion && m.version <= targetVersion
  ).sort((a, b) => a.version - b.version);

  if (pending.length === 0) return;
  log.info(
    `Migrating pathfinder_db from v${oldVersion} to v${targetVersion}: ` +
      pending.map((m) => `v${m.version}(${m.name})`).join(' → ')
  );

  for (const m of pending) {
    try {
      m.up(db, tx);
    } catch (err) {
      log.error(`Migration v${m.version} (${m.name}) failed — aborting upgrade`, err);
      throw err;
    }
  }
}

/** Guards the DB_VERSION/MIGRATIONS mismatch that silently skips a migration. */
export function assertMigrationsConsistent(): void {
  const max = MIGRATIONS.reduce((n, m) => Math.max(n, m.version), 0);
  if (max !== DB_VERSION) {
    throw new Error(
      `DB_VERSION (${DB_VERSION}) does not match the highest migration (${max}). ` +
        `Bump DB_VERSION when adding a migration, or the migration never runs.`
    );
  }
  const versions = MIGRATIONS.map((m) => m.version);
  if (new Set(versions).size !== versions.length) {
    throw new Error(`Duplicate migration versions: ${versions.join(', ')}`);
  }
}
