import { describe, it, expect, vi } from 'vitest';
import {
  createGraph,
  addNode,
  addEdge,
  getNode,
  serializeGraphForAI,
} from '../../../src/core/explorer/interaction-graph';

vi.mock('../../../src/storage/indexed-db', () => ({
  graphDB: {
    save: vi.fn(),
    load: vi.fn(),
    clear: vi.fn(),
  },
}));

describe('per-graph index isolation', () => {
  it('given two live graphs when mutated interleaved then indices do not cross-contaminate', () => {
    // Regression: indices were module-global, so building one graph clobbered
    // the other. addNode/getNode must resolve against the graph they are given.
    const a = createGraph();
    const b = createGraph();

    addNode(a, 'https://a.test/1', 'A1', 3);
    addNode(b, 'https://b.test/1', 'B1', 5);
    // Interleave: touching b must not affect a's index and vice versa.
    addNode(a, 'https://a.test/2', 'A2', 2);

    expect(getNode(a, 'https://a.test/1')?.title).toBe('A1');
    expect(getNode(a, 'https://b.test/1')).toBeUndefined();
    expect(getNode(b, 'https://b.test/1')?.title).toBe('B1');
    expect(getNode(b, 'https://a.test/2')).toBeUndefined();
    expect(a.nodes).toHaveLength(2);
    expect(b.nodes).toHaveLength(1);
  });

  it('given edge dedup when two graphs share a selector then each dedups independently', () => {
    const a = createGraph();
    const b = createGraph();
    addEdge(a, 'p1', 'p2', 'click', '.btn', 'Go');
    addEdge(a, 'p1', 'p2', 'click', '.btn', 'Go'); // dup in a
    addEdge(b, 'p1', 'p2', 'click', '.btn', 'Go'); // same key, different graph
    expect(a.edges).toHaveLength(1);
    expect(b.edges).toHaveLength(1);
  });
});

describe('createGraph', () => {
  it('given no input when creating then returns empty graph', () => {
    const graph = createGraph();
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.createdAt).toBeDefined();
    expect(graph.updatedAt).toBeDefined();
  });
});

describe('addNode', () => {
  it('given new url when adding node then node is added', () => {
    const graph = createGraph();
    const node = addNode(graph, 'https://app.com', 'Dashboard', 10);
    expect(graph.nodes).toHaveLength(1);
    expect(node.url).toBe('https://app.com');
    expect(node.title).toBe('Dashboard');
    expect(node.elementCount).toBe(10);
  });

  it('given duplicate url when adding node then returns existing node without duplicate', () => {
    const graph = createGraph();
    const node1 = addNode(graph, 'https://app.com', 'Dashboard', 10);
    const node2 = addNode(graph, 'https://app.com', 'Dashboard', 10);
    expect(graph.nodes).toHaveLength(1);
    expect(node1.id).toBe(node2.id);
  });

  it('given multiple unique urls when adding nodes then all are added', () => {
    const graph = createGraph();
    addNode(graph, 'https://app.com', 'Home', 5);
    addNode(graph, 'https://app.com/about', 'About', 3);
    addNode(graph, 'https://app.com/contact', 'Contact', 2);
    expect(graph.nodes).toHaveLength(3);
  });
});

describe('addEdge', () => {
  it('given two different urls when adding edge then edge is added', () => {
    const graph = createGraph();
    addEdge(graph, 'https://app.com', 'https://app.com/about', 'click', '#about', 'About');
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].from).toBe('https://app.com');
    expect(graph.edges[0].to).toBe('https://app.com/about');
  });

  it('given duplicate edge when adding then is not added again', () => {
    const graph = createGraph();
    addEdge(graph, 'https://app.com', 'https://app.com/about', 'click', '#about', 'About');
    addEdge(graph, 'https://app.com', 'https://app.com/about', 'click', '#about', 'About');
    expect(graph.edges).toHaveLength(1);
  });

  it('given same from but different selectors when adding then both edges added', () => {
    const graph = createGraph();
    addEdge(graph, 'https://app.com', 'https://app.com/a', 'click', '#a', 'Link A');
    addEdge(graph, 'https://app.com', 'https://app.com/a', 'click', '#b', 'Link B');
    expect(graph.edges).toHaveLength(2);
  });
});

describe('serializeGraphForAI', () => {
  it('given empty graph when serialized then returns placeholder text', () => {
    const graph = createGraph();
    const result = serializeGraphForAI(graph);
    expect(result).toContain('0');
  });

  it('given graph with nodes when serialized then includes node titles', () => {
    const graph = createGraph();
    addNode(graph, 'https://app.com', 'Dashboard', 10);
    addNode(graph, 'https://app.com/settings', 'Settings', 5);
    const result = serializeGraphForAI(graph);
    expect(result).toContain('Dashboard');
    expect(result).toContain('Settings');
  });

  it('given graph with edges when serialized then includes flow connections', () => {
    const graph = createGraph();
    addNode(graph, 'https://app.com', 'Home', 5);
    addNode(graph, 'https://app.com/create', 'Create', 3);
    addEdge(graph, 'https://app.com', 'https://app.com/create', 'click', '#create', 'Create New');
    const result = serializeGraphForAI(graph);
    expect(result).toContain('→');
    expect(result).toContain('Create New');
  });
});
