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

const DB_NAME = 'pathfinder_db';
const DB_VERSION = 2;

const STORES = {
  vectors: 'vectors',
  documents: 'documents',
  flows: 'flows',
  testCases: 'test_cases',
  testResults: 'test_results',
  executionPlans: 'execution_plans',
  interactionGraph: 'interaction_graph',
  testRuns: 'test_runs',
  graphSnapshots: 'graph_snapshots',
} as const;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(new Error(`IndexedDB open failed: ${request.error?.message}`));
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // ── v1 stores ─────────────────────────────────────────────────────────
      if (!db.objectStoreNames.contains(STORES.vectors)) {
        const vectorStore = db.createObjectStore(STORES.vectors, { keyPath: 'id' });
        vectorStore.createIndex('url', 'url', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.documents)) {
        const docStore = db.createObjectStore(STORES.documents, { keyPath: 'id' });
        docStore.createIndex('url', 'url', { unique: true });
      }

      if (!db.objectStoreNames.contains(STORES.flows)) {
        db.createObjectStore(STORES.flows, { keyPath: 'flowId' });
      }

      if (!db.objectStoreNames.contains(STORES.testCases)) {
        const testStore = db.createObjectStore(STORES.testCases, { keyPath: 'id' });
        testStore.createIndex('sourceFlowId', 'sourceFlowId', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.testResults)) {
        const resultStore = db.createObjectStore(STORES.testResults, { keyPath: 'id' });
        resultStore.createIndex('testCaseId', 'testCaseId', { unique: false });
        resultStore.createIndex('runId', 'runId', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.executionPlans)) {
        const planStore = db.createObjectStore(STORES.executionPlans, { keyPath: 'id' });
        planStore.createIndex('testCaseHash', 'testCaseHash', { unique: false });
        planStore.createIndex('testCaseId', 'testCaseId', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.interactionGraph)) {
        db.createObjectStore(STORES.interactionGraph, { keyPath: 'id', autoIncrement: true });
      }

      if (!db.objectStoreNames.contains(STORES.testRuns)) {
        db.createObjectStore(STORES.testRuns, { keyPath: 'id' });
      }

      // ── v2 stores ─────────────────────────────────────────────────────────
      if (!db.objectStoreNames.contains(STORES.graphSnapshots)) {
        const snapStore = db.createObjectStore(STORES.graphSnapshots, { keyPath: 'id' });
        snapStore.createIndex('savedAt', 'savedAt', { unique: false });
      }

      // ── v2 index additions for existing stores ────────────────────────────
      // Add testCaseId index to executionPlans if missing (v1 didn't have it)
      if (event.oldVersion < 2) {
        try {
          const planStore = (event.target as IDBOpenDBRequest).transaction!.objectStore(STORES.executionPlans);
          if (!planStore.indexNames.contains('testCaseId')) {
            planStore.createIndex('testCaseId', 'testCaseId', { unique: false });
          }
        } catch {
          // Store may not exist in transaction — handled above
        }
      }
    };
  });
}

function transaction<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return new Promise(async (resolve, reject) => {
    const db = await openDB();
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const request = fn(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error(`DB operation failed: ${request.error?.message}`));
    tx.oncomplete = () => db.close();
    tx.onerror = () => reject(new Error(`Transaction failed: ${tx.error?.message}`));
  });
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
  return new Promise(async (resolve, reject) => {
    const db = await openDB();
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.index(indexName).getAll(key);
    req.onsuccess = () => { db.close(); resolve(req.result as T[]); };
    req.onerror = () => reject(new Error(`queryByIndex failed: ${req.error?.message}`));
  });
}

/**
 * Get a single record by index (returns first match).
 */
function getByIndex<T>(storeName: string, indexName: string, key: IDBValidKey): Promise<T | undefined> {
  return new Promise(async (resolve, reject) => {
    const db = await openDB();
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.index(indexName).get(key);
    req.onsuccess = () => { db.close(); resolve(req.result as T | undefined); };
    req.onerror = () => reject(new Error(`getByIndex failed: ${req.error?.message}`));
  });
}

/**
 * Paginated retrieval from a store using a cursor.
 * Returns `limit` records starting from `offset`.
 */
function getPage<T>(storeName: string, offset: number, limit: number): Promise<T[]> {
  return new Promise(async (resolve, reject) => {
    const db = await openDB();
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const results: T[] = [];
    let skipped = 0;

    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || results.length >= limit) {
        db.close();
        resolve(results);
        return;
      }
      if (skipped < offset) {
        skipped++;
        cursor.continue();
        return;
      }
      results.push(cursor.value as T);
      cursor.continue();
    };
    req.onerror = () => reject(new Error(`getPage failed: ${req.error?.message}`));
  });
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
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(new Error(`Batch put failed: ${tx.error?.message}`));
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
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(new Error(`vectorDB.deleteByUrl failed: ${tx.error?.message}`));
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
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(new Error(`documentDB.putBatch failed: ${tx.error?.message}`));
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

      tx.oncomplete = () => {
        db.close();
        if (relatedTests.length > 0) {
          log.info(`Cascade-deleted ${relatedTests.length} test cases for flow ${flowId}`);
        }
        resolve({ deletedTestCases: relatedTests.length });
      };
      tx.onerror = () => reject(new Error(`flowDB.deleteWithCascade failed: ${tx.error?.message}`));
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
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(new Error('Graph save failed'));
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
