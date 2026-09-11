import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GraphSnapshot } from '../../../src/storage/schemas';

vi.mock('../../../src/core/explorer/interaction-graph', () => ({
  loadGraph: vi.fn().mockResolvedValue(undefined),
  getGraphSnapshots: vi.fn(),
  restoreGraphSnapshot: vi.fn(),
  deleteGraphSnapshot: vi.fn().mockResolvedValue(undefined),
  clearGraphSnapshots: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/core/flow/flow-store', () => ({ getAllFlows: vi.fn().mockResolvedValue([]) }));
vi.mock('../../../src/messaging/messenger', () => ({ sendToBackground: vi.fn() }));

const { useExplorerStore } = await import('../../../src/sidepanel/stores/explorer-store');
const graphMod = await import('../../../src/core/explorer/interaction-graph');

function snap(id: string): GraphSnapshot {
  return {
    id,
    graph: { nodes: [], edges: [], createdAt: '', updatedAt: '' },
    savedAt: '2026-09-11T00:00:00.000Z',
    nodeCount: 0,
    edgeCount: 0,
  } as GraphSnapshot;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(graphMod.getGraphSnapshots).mockResolvedValue([snap('a'), snap('b'), snap('c')]);
  useExplorerStore.setState({
    snapshots: [snap('a'), snap('b'), snap('c')],
    error: null,
  } as never);
});

describe('deleteSnapshot', () => {
  it('given_a_snapshot_id_then_it_is_deleted_from_storage', async () => {
    await useExplorerStore.getState().deleteSnapshot('b');
    expect(graphMod.deleteGraphSnapshot).toHaveBeenCalledWith('b');
  });

  it('given_a_delete_then_the_row_is_removed_from_the_list', async () => {
    vi.mocked(graphMod.getGraphSnapshots).mockResolvedValue([snap('a'), snap('c')]);
    await useExplorerStore.getState().deleteSnapshot('b');
    expect(useExplorerStore.getState().snapshots.map((s) => s.id)).toEqual(['a', 'c']);
  });

  // If the re-read fails the row would stay on screen and look undeletable.
  it('given_the_reread_fails_then_the_row_is_still_gone_locally', async () => {
    vi.mocked(graphMod.getGraphSnapshots).mockRejectedValue(new Error('db closed'));
    await useExplorerStore.getState().deleteSnapshot('b');
    expect(useExplorerStore.getState().snapshots.map((s) => s.id)).toEqual(['a', 'c']);
    expect(useExplorerStore.getState().error).toBeNull();
  });

  it('given_the_delete_itself_fails_then_the_error_is_surfaced_and_nothing_is_removed', async () => {
    vi.mocked(graphMod.deleteGraphSnapshot).mockRejectedValue(new Error('quota'));
    await useExplorerStore.getState().deleteSnapshot('b');
    expect(useExplorerStore.getState().error).toBe('quota');
    expect(useExplorerStore.getState().snapshots).toHaveLength(3);
  });

  it('given_an_unknown_id_then_it_resolves_without_changing_the_others', async () => {
    vi.mocked(graphMod.getGraphSnapshots).mockResolvedValue([snap('a'), snap('b'), snap('c')]);
    await useExplorerStore.getState().deleteSnapshot('zzz');
    expect(useExplorerStore.getState().snapshots.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('clearSnapshots', () => {
  it('given_a_clear_then_every_snapshot_is_removed', async () => {
    await useExplorerStore.getState().clearSnapshots();
    expect(graphMod.clearGraphSnapshots).toHaveBeenCalled();
    expect(useExplorerStore.getState().snapshots).toEqual([]);
  });

  it('given_a_failure_then_the_error_is_surfaced_and_the_list_is_kept', async () => {
    vi.mocked(graphMod.clearGraphSnapshots).mockRejectedValue(new Error('db closed'));
    await useExplorerStore.getState().clearSnapshots();
    expect(useExplorerStore.getState().error).toBe('db closed');
    expect(useExplorerStore.getState().snapshots).toHaveLength(3);
  });

  // Deleting history must never touch the graph the user is working on.
  it('given_a_clear_then_the_active_graph_is_untouched', async () => {
    const graph = { nodes: [{ url: 'x' }], edges: [] };
    useExplorerStore.setState({ graph } as never);
    await useExplorerStore.getState().clearSnapshots();
    expect(useExplorerStore.getState().graph).toBe(graph);
  });
});
