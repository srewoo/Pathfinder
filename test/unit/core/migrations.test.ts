/**
 * Migration chain tests (fix.md §12).
 *
 * Run against fake-indexeddb, so these exercise the real `onupgradeneeded` path
 * rather than a mock of it. The scenario that matters is a user upgrading with
 * existing data: the interaction graph shape will change, and their records must
 * survive.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  DB_NAME,
  DB_VERSION,
  MIGRATIONS,
  STORES,
  assertMigrationsConsistent,
  runMigrations,
} from '../../../src/storage/migrations';

/** Open at `version`, running the chain, and hand back the db. */
function openAt(factory: IDBFactory, version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, version);
    req.onupgradeneeded = (event) => {
      const target = event.target as IDBOpenDBRequest;
      runMigrations(target.result, target.transaction!, event.oldVersion);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function put(db: IDBDatabase, store: string, value: object): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function getAll<T>(db: IDBDatabase, store: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

describe('migration chain consistency', () => {
  it('given_the_declared_version_then_it_matches_the_highest_migration', () => {
    // A mismatch means the newest migration silently never runs.
    expect(() => assertMigrationsConsistent()).not.toThrow();
  });

  it('given_the_chain_then_versions_are_unique_and_ordered_from_one', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions[0]).toBe(1);
  });

  it('given_every_migration_then_it_has_a_descriptive_name', () => {
    for (const m of MIGRATIONS) expect(m.name).toMatch(/^[a-z0-9-]+$/);
  });
});

describe('fresh install', () => {
  let factory: IDBFactory;
  beforeEach(() => {
    factory = new IDBFactory();
  });

  it('given_a_fresh_database_then_every_store_exists_at_the_current_version', async () => {
    const db = await openAt(factory, DB_VERSION);
    const names = [...db.objectStoreNames];
    for (const store of Object.values(STORES)) {
      expect(names).toContain(store);
    }
    db.close();
  });

  it('given_a_fresh_database_then_the_jobs_store_has_its_pump_indexes', async () => {
    const db = await openAt(factory, DB_VERSION);
    const store = db.transaction(STORES.jobs, 'readonly').objectStore(STORES.jobs);
    expect([...store.indexNames]).toContain('state');
    expect([...store.indexNames]).toContain('updatedAt');
    db.close();
  });
});

describe('upgrade from an older version with existing data', () => {
  let factory: IDBFactory;
  beforeEach(() => {
    factory = new IDBFactory();
  });

  it('given_a_v1_database_with_data_then_upgrading_preserves_it_and_adds_new_stores', async () => {
    // Simulate a real user on v1 with a crawled document.
    const v1 = await openAt(factory, 1);
    expect([...v1.objectStoreNames]).not.toContain(STORES.jobs);
    await put(v1, STORES.documents, { id: 'd1', url: 'https://app.test/', title: 'Doc' });
    v1.close();

    const current = await openAt(factory, DB_VERSION);
    const docs = await getAll<{ id: string; title: string }>(current, STORES.documents);
    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe('Doc');
    // And the v2 + v3 stores now exist.
    expect([...current.objectStoreNames]).toContain(STORES.graphSnapshots);
    expect([...current.objectStoreNames]).toContain(STORES.jobs);
    current.close();
  });

  it('given_a_v1_database_then_the_v2_plan_index_is_added', async () => {
    const v1 = await openAt(factory, 1);
    v1.close();
    const current = await openAt(factory, DB_VERSION);
    const store = current
      .transaction(STORES.executionPlans, 'readonly')
      .objectStore(STORES.executionPlans);
    expect([...store.indexNames]).toContain('testCaseId');
    current.close();
  });

  it('given_a_v2_database_then_only_the_v3_migration_runs_and_data_survives', async () => {
    const v2 = await openAt(factory, 2);
    await put(v2, STORES.testCases, { id: 't1', sourceFlowId: 'f1' });
    v2.close();

    const current = await openAt(factory, DB_VERSION);
    expect(await getAll(current, STORES.testCases)).toHaveLength(1);
    expect([...current.objectStoreNames]).toContain(STORES.runArtifacts);
    current.close();
  });

  it('given_an_already_current_database_then_reopening_is_a_no_op', async () => {
    const first = await openAt(factory, DB_VERSION);
    await put(first, STORES.flows, { flowId: 'f1', name: 'Login' });
    first.close();

    const second = await openAt(factory, DB_VERSION);
    expect(await getAll(second, STORES.flows)).toHaveLength(1);
    second.close();
  });
});

describe('migration failure handling', () => {
  it('given_a_migration_that_throws_then_the_upgrade_aborts_rather_than_half_applying', async () => {
    // A half-migrated database is worse than an un-migrated one, so a throwing
    // migration must abort the whole versionchange transaction.
    const factory = new IDBFactory();
    await expect(
      new Promise((resolve, reject) => {
        const req = factory.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          throw new Error('migration exploded');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
    ).rejects.toBeTruthy();
  });
});
