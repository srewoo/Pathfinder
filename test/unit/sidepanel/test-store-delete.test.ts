import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TestCase } from '../../../src/storage/schemas';

vi.mock('../../../src/storage/indexed-db', () => ({
  testCaseDB: { delete: vi.fn().mockResolvedValue(undefined) },
  testResultDB: {},
}));
vi.mock('../../../src/core/flow/flow-store', () => ({ getAllFlows: vi.fn().mockResolvedValue([]) }));
vi.mock('../../../src/core/test-gen/test-generator', () => ({ createUserTestCase: vi.fn() }));
vi.mock('../../../src/messaging/messenger', () => ({ sendToBackground: vi.fn() }));

const { useTestStore } = await import('../../../src/sidepanel/stores/test-store');
const { testCaseDB } = await import('../../../src/storage/indexed-db');

const tc = (id: string): TestCase => ({
  id, title: id, description: '', type: 'positive', source: 'generated', status: 'pending', createdAt: '',
});

describe('test-store.deleteTests (bulk delete)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTestStore.setState({
      testCases: [tc('a'), tc('b'), tc('c')],
      results: [{ testCaseId: 'a' }, { testCaseId: 'c' }] as never,
      selectedTestIds: ['a', 'c'],
      runningTestIds: [],
    } as never);
  });

  it('given a selection when deleteTests() then removes those tests from DB and state', async () => {
    await useTestStore.getState().deleteTests();

    expect(vi.mocked(testCaseDB.delete)).toHaveBeenCalledWith('a');
    expect(vi.mocked(testCaseDB.delete)).toHaveBeenCalledWith('c');
    const state = useTestStore.getState();
    expect(state.testCases.map((t) => t.id)).toEqual(['b']);
    expect(state.selectedTestIds).toEqual([]);
    // Results for deleted tests are cleaned up too.
    expect(state.results.some((r) => r.testCaseId === 'a' || r.testCaseId === 'c')).toBe(false);
  });

  it('given explicit ids when deleteTests(ids) then deletes those regardless of selection', async () => {
    await useTestStore.getState().deleteTests(['b']);
    expect(vi.mocked(testCaseDB.delete)).toHaveBeenCalledTimes(1);
    expect(useTestStore.getState().testCases.map((t) => t.id)).toEqual(['a', 'c']);
  });

  it('given a running test in the set then it is NOT deleted', async () => {
    useTestStore.setState({ runningTestIds: ['a'] } as never);
    await useTestStore.getState().deleteTests(['a', 'c']);
    expect(vi.mocked(testCaseDB.delete)).toHaveBeenCalledWith('c');
    expect(vi.mocked(testCaseDB.delete)).not.toHaveBeenCalledWith('a');
    expect(useTestStore.getState().testCases.map((t) => t.id).sort()).toEqual(['a', 'b']);
  });

  it('given an empty selection when deleteTests() then is a no-op', async () => {
    useTestStore.setState({ selectedTestIds: [] } as never);
    await useTestStore.getState().deleteTests();
    expect(vi.mocked(testCaseDB.delete)).not.toHaveBeenCalled();
  });
});
