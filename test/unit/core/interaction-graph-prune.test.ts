import { describe, it, expect } from 'vitest';
import { createGraph, addNode, addEdge, pruneStaleNodes } from '../../../src/core/explorer/interaction-graph';

describe('pruneStaleNodes', () => {
  it('given pages not in keep-set then removes them and keeps the rest', () => {
    const g = createGraph();
    addNode(g, 'https://app/a', 'A', 1);
    addNode(g, 'https://app/b', 'B', 1);
    addNode(g, 'https://app/gone', 'Gone', 1);

    const removed = pruneStaleNodes(g, new Set(['https://app/a', 'https://app/b']));

    expect(removed).toEqual(['https://app/gone']);
    expect(g.nodes.map((n) => n.url).sort()).toEqual(['https://app/a', 'https://app/b']);
  });

  it('given edges touching a pruned node then those edges are dropped too', () => {
    const g = createGraph();
    addNode(g, 'https://app/a', 'A', 1);
    addNode(g, 'https://app/gone', 'Gone', 1);
    addEdge(g, 'https://app/a', 'https://app/gone', 'link', 'a[href]', 'Gone');
    addEdge(g, 'https://app/gone', 'https://app/a', 'link', 'a[href]', 'Back');

    pruneStaleNodes(g, new Set(['https://app/a']));

    expect(g.nodes).toHaveLength(1);
    expect(g.edges.some((e) => e.from === 'https://app/gone' || e.to === 'https://app/gone')).toBe(false);
  });

  it('given all pages are in the keep-set then nothing is removed', () => {
    const g = createGraph();
    addNode(g, 'https://app/a', 'A', 1);
    const removed = pruneStaleNodes(g, new Set(['https://app/a']));
    expect(removed).toEqual([]);
    expect(g.nodes).toHaveLength(1);
  });
});
