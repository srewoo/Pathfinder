import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createGraph,
  addNode,
  addEdge,
  serializeGraphForAI,
} from '../../../src/core/explorer/interaction-graph';

vi.mock('../../../src/storage/indexed-db', () => ({
  graphDB: {
    save: vi.fn(),
    load: vi.fn(),
    clear: vi.fn(),
  },
}));

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
