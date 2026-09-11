import type {
  VectorRecord,
  CrawledDocument,
  Flow,
  TestCase,
  TestResult,
  ExecutionPlan,
  InteractionGraph,
  TestRun,
  GraphSnapshot,
} from './schemas';
import { createLogger } from '../utils/logger';

const log = createLogger('indexed-db');

// Schema, version and the migration chain live in ./migrations (fix.md §12) so
// the upgrade path is explicit and reviewable rather than implied by a pile of
// existence guards.
import { DB_NAME, DB_VERSION, STORES, runMigrations } from './migrations';

export { STORES };

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(new Error(`IndexedDB open failed: ${request.error?.message}`));
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const target = event.target as IDBOpenDBRequest;
      const db = target.result;
      const tx = target.transaction;
      if (!tx) {
        reject(new Error('No versionchange transaction available for migration'));
        return;
      }
      runMigrations(db, tx, event.oldVersion);
    };
  });
}

/**
 * Run one transaction and settle only when it has finished.
 *
 * Two corrections live here, and both were silent.
 *
 * `openDB()` is awaited OUTSIDE the promise executor. It used to be awaited
 * inside `new Promise(async …)`, where a rejected open settled the executor's
 * own discarded promise and never the outer one — so a failed open hung every
 * caller forever instead of surfacing an error.
 *
 * Resolution waits for `tx.oncomplete`, not `request.onsuccess`. A request can
 * succeed and the transaction still abort — quota exhausted, a sibling request
 * failing, an explicit abort — and the old code told the caller its write had
 * landed before the commit that would have made that true. Reads settle the
 * same way: `oncomplete` follows a successful read immediately, so one rule
 * costs nothing and leaves no second path to get wrong.
 */
async function transaction<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openDB();
  try {
    return await new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction;
      let request: IDBRequest<T>;
      try {
        // Both of these throw synchronously — an unknown store name, a closed
        // connection, a bad index. Inside an async executor that became an
        // unhandled rejection and another indefinite hang.
        tx = db.transaction(storeName, mode);
        request = fn(tx.objectStore(storeName));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      // The request's own error is the useful one; the transaction-level error
      // that follows is a consequence of it. Keeping the first means the caller
      // is told what actually failed.
      let failure: Error | undefined;
      request.onerror = () => {
        failure ??= new Error(`DB operation failed: ${request.error?.message}`);
      };
      tx.onerror = () => {
        failure ??= new Error(`Transaction failed: ${tx.error?.message}`);
      };
      tx.onabort = () => {
        reject(failure ?? new Error(`Transaction aborted: ${tx.error?.message ?? 'unknown reason'}`));
      };
      tx.oncomplete = () => {
        if (failure) reject(failure);
        else resolve(request.result);
      };
    });
  } finally {
    // Safe in every path: the promise above settles only once the transaction
    // has completed or aborted, so this can never cut a commit short.
    db.close();
  }
}

function getAllFromStore<T>(storeName: string): Promise<T[]> {
  return transaction<T[]>(storeName, 'readonly', (store) => store.getAll());
}

function putInStore<T>(storeName: string, item: T): Promise<IDBValidKey> {
  return transaction<IDBValidKey>(storeName, 'readwrite', (store) => store.put(item));
}

function deleteFromStore(storeName: string, key: IDBValidKey): Promise<undefined> {
  return transaction<undefined>(storeName, 'readwrite', (store) => store.delete(key));
}

function getFromStore<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  return transaction<T | undefined>(storeName, 'readonly', (store) => store.get(key));
}

async function clearStore(storeName: string): Promise<undefined> {
  return transaction<undefined>(storeName, 'readwrite', (store) => store.clear());
}

/**
 * Query records from a store using an index. Returns matching records directly
 * from the index instead of loading all records and filtering in JS.
 */
function queryByIndex<T>(storeName: string, indexName: string, key: IDBValidKey): Promise<T[]> {
  // Routed through `transaction` rather than opening its own connection: it had
  // the same async-executor hang, and it closed the database only on the success
  // path, leaking a connection on every failed query.
  return transaction<T[]>(storeName, 'readonly', (store) => store.index(indexName).getAll(key));
}

/**
 * Get a single record by index (returns first match).
 */
function getByIndex<T>(storeName: string, indexName: string, key: IDBValidKey): Promise<T | undefined> {
  return transaction<T | undefined>(storeName, 'readonly', (store) =>
    store.index(indexName).get(key)
  );
}

/**
 * Paginated retrieval from a store using a cursor.
 * Returns `limit` records starting from `offset`.
 */
async function getPage<T>(storeName: string, offset: number, limit: number): Promise<T[]> {
  const db = await openDB();
  try {
    return await new Promise<T[]>((resolve, reject) => {
      let tx: IDBTransaction;
      let req: IDBRequest<IDBCursorWithValue | null>;
      try {
        tx = db.transaction(storeName, 'readonly');
        req = tx.objectStore(storeName).openCursor();
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      const results: T[] = [];
      let skipped = 0;
      let failure: Error | undefined;

      req.onsuccess = () => {
        const cursor = req.result;
        // Stopping the walk does not resolve — `oncomplete` does, once the
        // transaction it belongs to has actually finished.
        if (!cursor || results.length >= limit) return;
        if (skipped < offset) {
          skipped++;
          cursor.continue();
          return;
        }
        results.push(cursor.value as T);
        cursor.continue();
      };
      req.onerror = () => {
        failure ??= new Error(`getPage failed: ${req.error?.message}`);
      };
      tx.onabort = () => {
        reject(failure ?? new Error(`getPage transaction aborted: ${tx.error?.message ?? 'unknown reason'}`));
      };
      tx.oncomplete = () => {
        if (failure) reject(failure);
        else resolve(results);
      };
    });
  } finally {
    db.close();
  }
}

/**
 * Wire a batch transaction's terminal handlers.
 *
 * Every batch site already resolved on `oncomplete`, which is right, but closed
 * the connection only there — leaking one on every failure — and none handled
 * `onabort`, so a quota abort left the caller waiting forever on a promise that
 * would never settle.
 */
function settleBatch<T>(
  db: IDBDatabase,
  tx: IDBTransaction,
  label: string,
  onComplete: () => T,
  resolve: (value: T) => void,
  reject: (error: Error) => void
): void {
  let settled = false;
  const finish = (fn: () => void) => {
    if (settled) return;
    settled = true;
    db.close();
    fn();
  };
  tx.oncomplete = () => finish(() => resolve(onComplete()));
  tx.onerror = () =>
    finish(() => reject(new Error(`${label} failed: ${tx.error?.message ?? 'transaction error'}`)));
  tx.onabort = () =>
    finish(() => reject(new Error(`${label} aborted: ${tx.error?.message ?? 'unknown reason'}`)));
}


// ── Vectors ─────────────────────────────────────────────────────────────────
export const vectorDB = {
  async put(record: VectorRecord): Promise<void> {
    await putInStore(STORES.vectors, record);
  },

  async putBatch(records: VectorRecord[]): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.vectors, 'readwrite');
      const store = tx.objectStore(STORES.vectors);
      records.forEach((r) => store.put(r));
      settleBatch(db, tx, 'vectorDB.putBatch', () => undefined, resolve, reject);
    });
  },

  async getAll(): Promise<VectorRecord[]> {
    return getAllFromStore<VectorRecord>(STORES.vectors);
  },

  /**
   * Paginated retrieval of vectors. Use this instead of getAll() for large datasets.
   * Returns `limit` records starting from `offset`.
   */
  async getPage(offset: number, limit: number): Promise<VectorRecord[]> {
    return getPage<VectorRecord>(STORES.vectors, offset, limit);
  },

  /** Get all vectors for a specific URL using the 'url' index. */
  async getByUrl(url: string): Promise<VectorRecord[]> {
    return queryByIndex<VectorRecord>(STORES.vectors, 'url', url);
  },

  /** Delete all vector records whose url matches. Uses the 'url' index. */
  async deleteByUrl(url: string): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.vectors, 'readwrite');
      const store = tx.objectStore(STORES.vectors);
      const req = store.index('url').getAll(url);
      req.onsuccess = () => {
        (req.result as VectorRecord[]).forEach((r) => store.delete(r.id));
      };
      settleBatch(db, tx, 'vectorDB.deleteByUrl', () => undefined, resolve, reject);
    });
  },

  async clear(): Promise<void> {
    await clearStore(STORES.vectors);
  },

  async count(): Promise<number> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.vectors, 'readonly');
      const req = tx.objectStore(STORES.vectors).count();
      req.onsuccess = () => { db.close(); resolve(req.result); };
      req.onerror = () => reject(new Error('Count failed'));
    });
  },
};

// ── Documents ───────────────────────────────────────────────────────────────
export const documentDB = {
  async put(doc: CrawledDocument): Promise<void> {
    await putInStore(STORES.documents, doc);
  },

  async getAll(): Promise<CrawledDocument[]> {
    return getAllFromStore<CrawledDocument>(STORES.documents);
  },

  async putBatch(docs: CrawledDocument[]): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.documents, 'readwrite');
      const store = tx.objectStore(STORES.documents);
      docs.forEach((d) => store.put(d));
      settleBatch(db, tx, 'documentDB.putBatch', () => undefined, resolve, reject);
    });
  },

  /** Look up a document by URL using the 'url' unique index. */
  async getByUrl(url: string): Promise<CrawledDocument | undefined> {
    return getByIndex<CrawledDocument>(STORES.documents, 'url', url);
  },

  /** Delete a document by URL (resolves silently if the URL is not found). */
  async deleteByUrl(url: string): Promise<void> {
    const doc = await documentDB.getByUrl(url);
    if (doc) await deleteFromStore(STORES.documents, doc.id);
  },

  async clear(): Promise<void> {
    await clearStore(STORES.documents);
  },

  async count(): Promise<number> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.documents, 'readonly');
      const req = tx.objectStore(STORES.documents).count();
      req.onsuccess = () => { db.close(); resolve(req.result); };
      req.onerror = () => reject(new Error('Count failed'));
    });
  },
};

// ── Flows ───────────────────────────────────────────────────────────────────
export const flowDB = {
  async put(flow: Flow): Promise<void> {
    await putInStore(STORES.flows, flow);
  },

  async get(flowId: string): Promise<Flow | undefined> {
    return getFromStore<Flow>(STORES.flows, flowId);
  },

  async getAll(): Promise<Flow[]> {
    return getAllFromStore<Flow>(STORES.flows);
  },

  async delete(flowId: string): Promise<void> {
    await deleteFromStore(STORES.flows, flowId);
  },

  /**
   * Delete a flow and cascade-delete all test cases that reference it.
   * Prevents orphaned test cases when a flow is removed.
   */
  async deleteWithCascade(flowId: string): Promise<{ deletedTestCases: number }> {
    const relatedTests = await queryByIndex<TestCase>(
      STORES.testCases,
      'sourceFlowId',
      flowId
    );
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORES.flows, STORES.testCases], 'readwrite');
      const flowStore = tx.objectStore(STORES.flows);
      const testStore = tx.objectStore(STORES.testCases);

      flowStore.delete(flowId);
      for (const tc of relatedTests) {
        testStore.delete(tc.id);
      }

      settleBatch(
        db,
        tx,
        'flowDB.deleteWithCascade',
        () => {
          if (relatedTests.length > 0) {
            log.info(`Cascade-deleted ${relatedTests.length} test cases for flow ${flowId}`);
          }
          return { deletedTestCases: relatedTests.length };
        },
        resolve,
        reject
      );
    });
  },

  async clear(): Promise<void> {
    await clearStore(STORES.flows);
  },
};

// ── Test Cases ──────────────────────────────────────────────────────────────
export const testCaseDB = {
  async put(testCase: TestCase): Promise<void> {
    await putInStore(STORES.testCases, testCase);
  },

  async get(id: string): Promise<TestCase | undefined> {
    return getFromStore<TestCase>(STORES.testCases, id);
  },

  async getAll(): Promise<TestCase[]> {
    return getAllFromStore<TestCase>(STORES.testCases);
  },

  /** Get all test cases for a specific flow using the index. */
  async getByFlowId(flowId: string): Promise<TestCase[]> {
    return queryByIndex<TestCase>(STORES.testCases, 'sourceFlowId', flowId);
  },

  async delete(id: string): Promise<void> {
    await deleteFromStore(STORES.testCases, id);
  },

  async clear(): Promise<void> {
    await clearStore(STORES.testCases);
  },
};

// ── Test Results ────────────────────────────────────────────────────────────
export const testResultDB = {
  async put(result: TestResult): Promise<void> {
    await putInStore(STORES.testResults, result);
  },

  async getAll(): Promise<TestResult[]> {
    return getAllFromStore<TestResult>(STORES.testResults);
  },

  /** Get results by run ID using the 'runId' index (was: getAll + filter). */
  async getByRunId(runId: string): Promise<TestResult[]> {
    return queryByIndex<TestResult>(STORES.testResults, 'runId', runId);
  },

  /** Get results by test case ID using the 'testCaseId' index. */
  async getByTestCaseId(testCaseId: string): Promise<TestResult[]> {
    return queryByIndex<TestResult>(STORES.testResults, 'testCaseId', testCaseId);
  },

  async clear(): Promise<void> {
    await clearStore(STORES.testResults);
  },
};

// ── Execution Plans ─────────────────────────────────────────────────────────
export const planDB = {
  async put(plan: ExecutionPlan): Promise<void> {
    await putInStore(STORES.executionPlans, plan);
  },

  async delete(id: string): Promise<void> {
    await deleteFromStore(STORES.executionPlans, id);
  },

  async getAll(): Promise<ExecutionPlan[]> {
    return getAllFromStore<ExecutionPlan>(STORES.executionPlans);
  },

  /** Get plan by test case ID using the index (was: getAll + find). */
  async getByTestCaseId(testCaseId: string): Promise<ExecutionPlan | undefined> {
    const results = await queryByIndex<ExecutionPlan>(STORES.executionPlans, 'testCaseId', testCaseId);
    return results[0];
  },

  /** Get plan by content hash using the index (was: getAll + find). */
  async getByHash(hash: string): Promise<ExecutionPlan | undefined> {
    const results = await queryByIndex<ExecutionPlan>(STORES.executionPlans, 'testCaseHash', hash);
    return results[0];
  },

  async clear(): Promise<void> {
    await clearStore(STORES.executionPlans);
  },
};

// ── Interaction Graph ───────────────────────────────────────────────────────
export const graphDB = {
  /** Full save — clears and re-writes the entire graph (use for full refreshes). */
  async save(graph: InteractionGraph): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.interactionGraph, 'readwrite');
      const store = tx.objectStore(STORES.interactionGraph);
      store.clear();
      store.put({ ...graph, id: 1 });
      settleBatch(db, tx, 'graphDB.save', () => undefined, resolve, reject);
    });
  },

  /**
   * Incremental save — merges changed nodes/edges into the stored graph
   * without clearing. Only writes if there are actual changes.
   * Much faster than full save for large graphs with small deltas.
   */
  async saveIncremental(graph: InteractionGraph): Promise<void> {
    const existing = await graphDB.load();
    if (!existing) {
      return graphDB.save(graph);
    }

    // Detect changes by comparing counts and updatedAt
    const nodesChanged = existing.nodes.length !== graph.nodes.length ||
      existing.updatedAt !== graph.updatedAt;
    const edgesChanged = existing.edges.length !== graph.edges.length ||
      existing.updatedAt !== graph.updatedAt;

    if (!nodesChanged && !edgesChanged) return;

    // Merge: build a URL-keyed map for O(1) dedup
    const nodeMap = new Map(existing.nodes.map((n) => [n.url, n]));
    for (const node of graph.nodes) {
      nodeMap.set(node.url, node); // Overwrite with latest
    }

    const edgeSet = new Set(existing.edges.map((e) => `${e.from}|${e.to}|${e.selector}`));
    const mergedEdges = [...existing.edges];
    for (const edge of graph.edges) {
      const key = `${edge.from}|${edge.to}|${edge.selector}`;
      if (!edgeSet.has(key)) {
        mergedEdges.push(edge);
        edgeSet.add(key);
      }
    }

    const merged: InteractionGraph = {
      nodes: [...nodeMap.values()],
      edges: mergedEdges,
      createdAt: existing.createdAt,
      updatedAt: graph.updatedAt,
    };

    return graphDB.save(merged);
  },

  async load(): Promise<InteractionGraph | undefined> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.interactionGraph, 'readonly');
      const req = tx.objectStore(STORES.interactionGraph).get(1);
      req.onsuccess = () => { db.close(); resolve(req.result as InteractionGraph | undefined); };
      req.onerror = () => reject(new Error('Graph load failed'));
    });
  },

  async clear(): Promise<void> {
    await clearStore(STORES.interactionGraph);
  },

  /**
   * Save a versioned snapshot of the current graph for history/rollback.
   * Keeps the last `maxSnapshots` snapshots (default 10).
   */
  async saveSnapshot(label?: string, maxSnapshots = 10): Promise<GraphSnapshot | undefined> {
    const graph = await graphDB.load();
    if (!graph) return undefined;

    const snapshot: GraphSnapshot = {
      id: `snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      graph: { ...graph },
      savedAt: new Date().toISOString(),
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      label,
    };

    await putInStore(STORES.graphSnapshots, snapshot);

    // Prune old snapshots beyond maxSnapshots
    const all = await getAllFromStore<GraphSnapshot>(STORES.graphSnapshots);
    if (all.length > maxSnapshots) {
      const sorted = all.sort((a, b) => a.savedAt.localeCompare(b.savedAt));
      const toDelete = sorted.slice(0, sorted.length - maxSnapshots);
      for (const old of toDelete) {
        await deleteFromStore(STORES.graphSnapshots, old.id);
      }
    }

    log.info(`Graph snapshot saved: ${snapshot.id} (${snapshot.nodeCount} nodes, ${snapshot.edgeCount} edges)`);
    return snapshot;
  },

  /** List all graph snapshots ordered by date (newest first). */
  async getSnapshots(): Promise<GraphSnapshot[]> {
    const all = await getAllFromStore<GraphSnapshot>(STORES.graphSnapshots);
    return all.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  },

  /**
   * Delete one snapshot.
   *
   * Snapshots are capped at 10 and pruned oldest-first, so a run of automatic
   * ones can push a deliberately-kept snapshot out. Deleting the noise by hand
   * is what keeps the one that matters reachable.
   */
  async deleteSnapshot(snapshotId: string): Promise<void> {
    await deleteFromStore(STORES.graphSnapshots, snapshotId);
    log.info(`Graph snapshot deleted: ${snapshotId}`);
  },

  /** Delete every snapshot. Does not touch the active graph. */
  async clearSnapshots(): Promise<void> {
    await clearStore(STORES.graphSnapshots);
    log.info('All graph snapshots cleared');
  },

  /** Restore a specific graph snapshot as the active graph. */
  async restoreSnapshot(snapshotId: string): Promise<InteractionGraph | undefined> {
    const snapshot = await getFromStore<GraphSnapshot>(STORES.graphSnapshots, snapshotId);
    if (!snapshot) return undefined;

    await graphDB.save(snapshot.graph);
    log.info(`Graph restored from snapshot: ${snapshotId}`);
    return snapshot.graph;
  },
};

// ── Test Runs ───────────────────────────────────────────────────────────────
export const testRunDB = {
  async put(run: TestRun): Promise<void> {
    await putInStore(STORES.testRuns, run);
  },

  async getAll(): Promise<TestRun[]> {
    return getAllFromStore<TestRun>(STORES.testRuns);
  },

  async get(id: string): Promise<TestRun | undefined> {
    return getFromStore<TestRun>(STORES.testRuns, id);
  },
};

export async function clearAllData(): Promise<void> {
  await Promise.all([
    clearStore(STORES.vectors),
    clearStore(STORES.documents),
    clearStore(STORES.flows),
    clearStore(STORES.testCases),
    clearStore(STORES.testResults),
    clearStore(STORES.executionPlans),
    clearStore(STORES.interactionGraph),
    clearStore(STORES.testRuns),
    clearStore(STORES.graphSnapshots),
  ]);
}
