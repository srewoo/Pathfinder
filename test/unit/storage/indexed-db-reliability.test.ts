/**
 * T03 regression: IndexedDB operations must settle, and only when committed.
 *
 * Three failure modes, all silent:
 *
 *  1. `openDB()` was awaited inside `new Promise(async …)`. A rejected open
 *     settled the executor's own discarded promise, never the outer one, so a
 *     failed open hung every caller instead of surfacing.
 *  2. Writes resolved on `request.onsuccess`, before the transaction committed.
 *     A request can succeed and the transaction still abort — the caller was
 *     told the write had landed before anything made that true.
 *  3. The database was closed only on the success path, leaking a connection on
 *     every failure, and `onabort` was unhandled so an abort never rejected.
 *
 * `fake-indexeddb` does not produce these naturally, so each is injected.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { testCaseDB, vectorDB, testResultDB } from '../../../src/storage/indexed-db';
import type { TestCase, VectorRecord } from '../../../src/storage/schemas';

const realOpen = indexedDB.open.bind(indexedDB);

function testCase(id = 'tc-1'): TestCase {
  return {
    id,
    title: 'User can sign in',
    description: '',
    type: 'positive',
    source: 'generated',
    status: 'pending',
    createdAt: '2026-09-11T00:00:00.000Z',
  };
}

function vector(id = 'v-1'): VectorRecord {
  return {
    id,
    content: 'hello',
    url: 'https://docs.test/a',
    embedding: [0.1, 0.2],
    metadata: {
      title: 'A',
      section: 'intro',
      crawledAt: '2026-09-11T00:00:00.000Z',
      chunkIndex: 0,
      totalChunks: 1,
    },
  };
}

/** A request-shaped stub whose handlers can be driven by hand. */
interface FakeRequest {
  onerror: ((this: unknown, ev: unknown) => void) | null;
  onsuccess: ((this: unknown, ev: unknown) => void) | null;
  onupgradeneeded: ((this: unknown, ev: unknown) => void) | null;
  error: DOMException | null;
  result: unknown;
}

/**
 * Replace `indexedDB.open` with one that fails asynchronously, the way a real
 * blocked or corrupt database does.
 */
function makeOpenFail(message: string) {
  vi.spyOn(indexedDB, 'open').mockImplementation(() => {
    const req: FakeRequest = {
      onerror: null,
      onsuccess: null,
      onupgradeneeded: null,
      error: new DOMException(message, 'UnknownError'),
      result: undefined,
    };
    setTimeout(() => req.onerror?.call(req, {}), 0);
    return req as unknown as IDBOpenDBRequest;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  indexedDB.open = realOpen;
});

describe('a failed database open', () => {
  beforeEach(() => makeOpenFail('database is corrupt'));

  // The hang. Without a timeout guard this test would never finish, which is
  // exactly what the product did.
  it.each([
    ['a read', () => testCaseDB.getAll()],
    ['a write', () => testCaseDB.put(testCase())],
    ['a delete', () => testCaseDB.delete('tc-1')],
    ['an index query', () => testResultDB.getByTestCaseId('tc-1')],
  ])('given_a_failed_open_then_%s_rejects_rather_than_hanging', async (_name, op) => {
    await expect(
      Promise.race([
        op(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('HUNG: never settled')), 500)),
      ])
    ).rejects.toThrow(/IndexedDB open failed|corrupt/i);
  });

  it('given_a_failed_open_then_a_batch_write_rejects_rather_than_hanging', async () => {
    await expect(
      Promise.race([
        vectorDB.putBatch([vector()]),
        new Promise((_, reject) => setTimeout(() => reject(new Error('HUNG: never settled')), 500)),
      ])
    ).rejects.toThrow(/IndexedDB open failed|corrupt/i);
  });

  it('given_a_failed_open_then_the_error_names_the_cause', async () => {
    await expect(testCaseDB.getAll()).rejects.toThrow(/corrupt/);
  });
});

describe('a transaction that aborts after its request succeeded', () => {
  /**
   * Let the put succeed, then abort the transaction — the case the old code got
   * wrong, because it had already resolved on `request.onsuccess`.
   */
  function abortAfterSuccess() {
    const open = indexedDB.open.bind(indexedDB);
    vi.spyOn(indexedDB, 'open').mockImplementation((...args: Parameters<typeof open>) => {
      const req = open(...args);
      const state = { handler: null as null | ((ev: unknown) => void) };
      Object.defineProperty(req, 'onsuccess', {
        configurable: true,
        get: () => state.handler,
        set: (fn: (ev: unknown) => void) => {
          state.handler = (ev: unknown) => {
            const db = req.result as IDBDatabase;
            const realTx = db.transaction.bind(db);
            vi.spyOn(db, 'transaction').mockImplementation((...targs: Parameters<typeof realTx>) => {
              const tx = realTx(...targs);
              if (targs[1] !== 'readwrite') return tx;
              const realStore = tx.objectStore.bind(tx);
              vi.spyOn(tx, 'objectStore').mockImplementation((name: string) => {
                const store = realStore(name);
                const realPut = store.put.bind(store);
                vi.spyOn(store, 'put').mockImplementation((...pargs: Parameters<typeof realPut>) => {
                  const request = realPut(...pargs);
                  // IndexedDB fires request.onsuccess before tx.oncomplete, so
                  // aborting here is precisely the window in which the old code
                  // had already told the caller the write succeeded.
                  request.onsuccess = () => tx.abort();
                  return request;
                });
                return store;
              });
              return tx;
            });
            fn(ev);
          };
        },
      });
      return req;
    });
  }

  it('given_a_request_success_then_an_abort_then_the_write_rejects', async () => {
    abortAfterSuccess();
    await expect(
      Promise.race([
        testCaseDB.put(testCase('tc-abort')),
        new Promise((_, reject) => setTimeout(() => reject(new Error('HUNG: never settled')), 500)),
      ])
    ).rejects.toThrow(/abort/i);
  });
});

describe('a write that reports success is actually committed', () => {
  // The positive half of the same requirement: if `put` resolves, a read in a
  // brand-new transaction must see the record. Resolving before commit made
  // this a race that usually won.
  it('given_a_resolved_put_then_a_fresh_read_sees_the_record', async () => {
    await testCaseDB.clear();
    await testCaseDB.put(testCase('tc-committed'));

    const all = await testCaseDB.getAll();
    expect(all.map((t) => t.id)).toContain('tc-committed');
  });

  it('given_a_resolved_batch_write_then_every_record_is_readable', async () => {
    await vectorDB.clear();
    await vectorDB.putBatch([vector('v-1'), vector('v-2'), vector('v-3')]);

    const all = await vectorDB.getAll();
    expect(all.map((v) => v.id).sort()).toEqual(['v-1', 'v-2', 'v-3']);
  });

  it('given_a_resolved_delete_then_the_record_is_gone_on_a_fresh_read', async () => {
    await testCaseDB.clear();
    await testCaseDB.put(testCase('tc-del'));
    await testCaseDB.delete('tc-del');

    expect((await testCaseDB.getAll()).map((t) => t.id)).not.toContain('tc-del');
  });
});

describe('a synchronous transaction failure', () => {
  /**
   * `db.transaction()` throws synchronously for an unknown store. Inside an
   * async executor that became an unhandled rejection and another silent hang.
   */
  it('given_transaction_creation_throws_then_it_rejects_rather_than_hanging', async () => {
    const open = indexedDB.open.bind(indexedDB);
    vi.spyOn(indexedDB, 'open').mockImplementation((...args: Parameters<typeof open>) => {
      const req = open(...args);
      const state = { handler: null as null | ((ev: unknown) => void) };
      Object.defineProperty(req, 'onsuccess', {
        configurable: true,
        get: () => state.handler,
        set: (fn: (ev: unknown) => void) => {
          state.handler = (ev: unknown) => {
            const db = req.result as IDBDatabase;
            vi.spyOn(db, 'transaction').mockImplementation(() => {
              throw new DOMException('no such object store', 'NotFoundError');
            });
            fn(ev);
          };
        },
      });
      return req;
    });

    await expect(
      Promise.race([
        testCaseDB.getAll(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('HUNG: never settled')), 500)),
      ])
    ).rejects.toThrow(/object store/i);
  });
});

describe('reads still work normally', () => {
  // The fix changed when reads settle (on commit rather than on request
  // success). They must still return the same data.
  it('given_records_then_getAll_returns_them', async () => {
    await testCaseDB.clear();
    await testCaseDB.put(testCase('a'));
    await testCaseDB.put(testCase('b'));

    expect((await testCaseDB.getAll()).map((t) => t.id).sort()).toEqual(['a', 'b']);
  });

  it('given_an_empty_store_then_getAll_returns_an_empty_array', async () => {
    await testCaseDB.clear();
    expect(await testCaseDB.getAll()).toEqual([]);
  });

  it('given_a_missing_key_then_get_resolves_undefined_rather_than_rejecting', async () => {
    await testCaseDB.clear();
    expect(await testCaseDB.get('nope')).toBeUndefined();
  });
});
