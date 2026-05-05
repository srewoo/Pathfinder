import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';

// fake-indexeddb patches globalThis.indexedDB before the module loads
import {
  vectorDB,
  documentDB,
  flowDB,
  testCaseDB,
  testResultDB,
  planDB,
  graphDB,
  testRunDB,
  clearAllData,
} from '../../../src/storage/indexed-db';

import type {
  VectorRecord,
  CrawledDocument,
  Flow,
  TestCase,
  TestResult,
  ExecutionPlan,
  InteractionGraph,
  TestRun,
} from '../../../src/storage/schemas';

// --- Fixtures ---

function makeVector(id: string): VectorRecord {
  return {
    id,
    content: `Content for ${id}`,
    url: 'https://example.com/docs',
    embedding: [0.1, 0.2, 0.3],
    metadata: {
      title: 'Example Doc',
      section: 'Introduction',
      crawledAt: new Date().toISOString(),
      chunkIndex: 0,
      totalChunks: 1,
    },
  };
}

function makeDocument(id: string): CrawledDocument {
  return {
    id,
    url: `https://example.com/${id}`,
    title: `Doc ${id}`,
    content: `Content of ${id}`,
    crawledAt: new Date().toISOString(),
    chunkCount: 2,
  };
}

function makeFlow(flowId: string): Flow {
  return {
    flowId,
    name: `Flow ${flowId}`,
    description: 'A test flow',
    steps: [{ order: 1, action: 'click', target: '#btn', description: 'Click button' }],
    source: 'exploration',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeTestCase(id: string): TestCase {
  return {
    id,
    title: `Test ${id}`,
    description: 'A test case',
    type: 'positive',
    source: 'generated',
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
}

function makeTestResult(id: string, testCaseId: string, runId: string): TestResult {
  return {
    id,
    testCaseId,
    testCaseTitle: `Test ${testCaseId}`,
    status: 'passed',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    duration: 1500,
    steps: [],
    healingAttempts: [],
    runId,
  };
}

function makeExecutionPlan(id: string, hash: string): ExecutionPlan {
  return {
    id,
    testCaseId: 'tc-001',
    testCaseHash: hash,
    steps: [{ order: 1, action: 'click', selector: '#btn', description: 'Click' }],
    cachedAt: new Date().toISOString(),
  };
}

function makeGraph(): InteractionGraph {
  return {
    nodes: [
      { id: 'node-1', url: 'https://example.com', title: 'Home', visitedAt: new Date().toISOString(), elementCount: 5 },
    ],
    edges: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeTestRun(id: string): TestRun {
  return {
    id,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    testCaseIds: ['tc-001'],
    results: [],
    summary: { total: 1, passed: 1, failed: 0, error: 0 },
  };
}

// --- Tests ---

describe('vectorDB', () => {
  beforeEach(async () => { await vectorDB.clear(); });

  it('given new vector record when put then getAll returns it', async () => {
    await vectorDB.put(makeVector('v-001'));
    const records = await vectorDB.getAll();
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe('v-001');
  });

  it('given empty store when getAll then returns empty array', async () => {
    const records = await vectorDB.getAll();
    expect(records).toEqual([]);
  });

  it('given multiple records when putBatch then count matches', async () => {
    const records = [makeVector('v-a'), makeVector('v-b'), makeVector('v-c')];
    await vectorDB.putBatch(records);
    const count = await vectorDB.count();
    expect(count).toBe(3);
  });

  it('given existing records when clear then count is zero', async () => {
    await vectorDB.put(makeVector('v-1'));
    await vectorDB.clear();
    expect(await vectorDB.count()).toBe(0);
  });

  it('given same id when put twice then overwrites existing record', async () => {
    await vectorDB.put(makeVector('v-dup'));
    const updated = { ...makeVector('v-dup'), content: 'Updated content' };
    await vectorDB.put(updated);
    const records = await vectorDB.getAll();
    expect(records).toHaveLength(1);
    expect(records[0].content).toBe('Updated content');
  });
});

describe('documentDB', () => {
  beforeEach(async () => { await documentDB.clear(); });

  it('given new document when put then getAll returns it', async () => {
    await documentDB.put(makeDocument('doc-001'));
    const docs = await documentDB.getAll();
    expect(docs).toHaveLength(1);
    expect(docs[0].url).toBe('https://example.com/doc-001');
  });

  it('given empty store when count then returns zero', async () => {
    expect(await documentDB.count()).toBe(0);
  });

  it('given two documents when stored then count is two', async () => {
    await documentDB.put(makeDocument('d1'));
    await documentDB.put(makeDocument('d2'));
    expect(await documentDB.count()).toBe(2);
  });
});

describe('flowDB', () => {
  beforeEach(async () => { await flowDB.clear(); });

  it('given new flow when put then get returns it', async () => {
    await flowDB.put(makeFlow('flow-001'));
    const flow = await flowDB.get('flow-001');
    expect(flow).toBeDefined();
    expect(flow!.name).toBe('Flow flow-001');
  });

  it('given non-existent id when get then returns undefined', async () => {
    const flow = await flowDB.get('missing-id');
    expect(flow).toBeUndefined();
  });

  it('given multiple flows when getAll then returns all', async () => {
    await flowDB.put(makeFlow('f1'));
    await flowDB.put(makeFlow('f2'));
    const flows = await flowDB.getAll();
    expect(flows).toHaveLength(2);
  });

  it('given existing flow when delete then get returns undefined', async () => {
    await flowDB.put(makeFlow('f-del'));
    await flowDB.delete('f-del');
    expect(await flowDB.get('f-del')).toBeUndefined();
  });

  it('given empty store when getAll then returns empty array', async () => {
    expect(await flowDB.getAll()).toEqual([]);
  });
});

describe('testCaseDB', () => {
  beforeEach(async () => { await testCaseDB.clear(); });

  it('given new test case when put then get returns it', async () => {
    await testCaseDB.put(makeTestCase('tc-001'));
    const tc = await testCaseDB.get('tc-001');
    expect(tc).toBeDefined();
    expect(tc!.title).toBe('Test tc-001');
  });

  it('given test case when deleted then get returns undefined', async () => {
    await testCaseDB.put(makeTestCase('tc-del'));
    await testCaseDB.delete('tc-del');
    expect(await testCaseDB.get('tc-del')).toBeUndefined();
  });

  it('given multiple test cases when getAll then returns all', async () => {
    await testCaseDB.put(makeTestCase('tc-a'));
    await testCaseDB.put(makeTestCase('tc-b'));
    await testCaseDB.put(makeTestCase('tc-c'));
    expect(await testCaseDB.getAll()).toHaveLength(3);
  });
});

describe('testResultDB', () => {
  beforeEach(async () => { await testResultDB.clear(); });

  it('given test result when put then getAll returns it', async () => {
    await testResultDB.put(makeTestResult('r-001', 'tc-001', 'run-1'));
    const results = await testResultDB.getAll();
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('passed');
  });

  it('given results with mixed run ids when getByRunId then filters correctly', async () => {
    await testResultDB.put(makeTestResult('r-1', 'tc-001', 'run-a'));
    await testResultDB.put(makeTestResult('r-2', 'tc-002', 'run-a'));
    await testResultDB.put(makeTestResult('r-3', 'tc-003', 'run-b'));

    const runAResults = await testResultDB.getByRunId('run-a');
    expect(runAResults).toHaveLength(2);
    expect(runAResults.every((r) => r.runId === 'run-a')).toBe(true);
  });

  it('given non-existent run id when getByRunId then returns empty array', async () => {
    await testResultDB.put(makeTestResult('r-1', 'tc-1', 'run-x'));
    expect(await testResultDB.getByRunId('run-missing')).toEqual([]);
  });
});

describe('planDB', () => {
  beforeEach(async () => { await planDB.clear(); });

  it('given plan when put then getByHash returns it', async () => {
    await planDB.put(makeExecutionPlan('plan-1', 'hash-xyz'));
    const plan = await planDB.getByHash('hash-xyz');
    expect(plan).toBeDefined();
    expect(plan!.id).toBe('plan-1');
  });

  it('given non-existent hash when getByHash then returns undefined', async () => {
    expect(await planDB.getByHash('nonexistent-hash')).toBeUndefined();
  });

  it('given plans when clear then getByHash returns undefined', async () => {
    await planDB.put(makeExecutionPlan('plan-clear', 'hash-clear'));
    await planDB.clear();
    expect(await planDB.getByHash('hash-clear')).toBeUndefined();
  });
});

describe('graphDB', () => {
  beforeEach(async () => { await graphDB.clear(); });

  it('given interaction graph when saved then load returns it', async () => {
    const graph = makeGraph();
    await graphDB.save(graph);
    const loaded = await graphDB.load();
    expect(loaded).toBeDefined();
    expect(loaded!.nodes).toHaveLength(1);
    expect(loaded!.nodes[0].url).toBe('https://example.com');
  });

  it('given no graph saved when load then returns undefined', async () => {
    expect(await graphDB.load()).toBeUndefined();
  });

  it('given saved graph when saved again then replaces previous', async () => {
    await graphDB.save(makeGraph());
    const updatedGraph: InteractionGraph = {
      ...makeGraph(),
      nodes: [
        { id: 'n1', url: 'https://app.com', title: 'App', visitedAt: new Date().toISOString(), elementCount: 10 },
        { id: 'n2', url: 'https://app.com/about', title: 'About', visitedAt: new Date().toISOString(), elementCount: 3 },
      ],
    };
    await graphDB.save(updatedGraph);
    const loaded = await graphDB.load();
    expect(loaded!.nodes).toHaveLength(2);
  });
});

describe('testRunDB', () => {
  it('given test run when put then get returns it', async () => {
    await testRunDB.put(makeTestRun('run-001'));
    const run = await testRunDB.get('run-001');
    expect(run).toBeDefined();
    expect(run!.summary.total).toBe(1);
  });

  it('given multiple runs when getAll then returns all', async () => {
    await testRunDB.put(makeTestRun('run-x'));
    await testRunDB.put(makeTestRun('run-y'));
    const runs = await testRunDB.getAll();
    expect(runs.length).toBeGreaterThanOrEqual(2);
  });
});

describe('clearAllData', () => {
  it('given data in all stores when clearAllData then all stores are empty', async () => {
    await vectorDB.put(makeVector('v-1'));
    await documentDB.put(makeDocument('d-1'));
    await flowDB.put(makeFlow('f-1'));
    await testCaseDB.put(makeTestCase('tc-1'));
    await testResultDB.put(makeTestResult('r-1', 'tc-1', 'run-1'));
    await planDB.put(makeExecutionPlan('p-1', 'h-1'));
    await graphDB.save(makeGraph());

    await clearAllData();

    expect(await vectorDB.count()).toBe(0);
    expect(await documentDB.count()).toBe(0);
    expect(await flowDB.getAll()).toHaveLength(0);
    expect(await testCaseDB.getAll()).toHaveLength(0);
    expect(await testResultDB.getAll()).toHaveLength(0);
    expect(await graphDB.load()).toBeUndefined();
  });
});
