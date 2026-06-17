import { describe, it, expect } from 'vitest';
import { buildRAGQuery, pathTerms } from '../../../src/core/flow/flow-learner';
import type { InteractionGraph, PageNode } from '../../../src/storage/schemas';

const node = (partial: Partial<PageNode>): PageNode =>
  ({ id: 'n', url: 'https://app/', title: '', visitedAt: '', elementCount: 0, ...partial } as PageNode);

const graph = (nodes: PageNode[]): InteractionGraph =>
  ({ nodes, edges: [], createdAt: '', updatedAt: '' } as InteractionGraph);

describe('pathTerms', () => {
  it('given a URL with IDs then keeps meaningful segments and drops numeric/hex IDs', () => {
    expect(pathTerms('https://app/new/ui/callai/recording/5993642928991842993'))
      .toEqual(['new', 'callai', 'recording']);
  });

  it('given hyphenated segments then humanizes them', () => {
    expect(pathTerms('https://app/learner/review/coaching-dashboard'))
      .toEqual(['learner', 'review', 'coaching dashboard']);
  });
});

describe('buildRAGQuery', () => {
  it('given a feature page with no title/forms then falls back to URL path + headings + tabs', () => {
    const q = buildRAGQuery(graph([
      node({
        url: 'https://app/new/ui/callai/recording/5993642928991842993',
        title: '...', // unusable
        headings: ['Follow up: Integration data'],
        tabs: [{ label: 'Transcript', url: 'https://app/...?tab=transcript' }],
      }),
    ]));
    expect(q).toContain('recording');                 // from URL path
    expect(q).toContain('callai');                    // from URL path
    expect(q).toContain('Follow up: Integration data'); // from headings
    expect(q).toContain('Transcript');                // from tabs
  });

  it('given usable titles then includes them and dedupes case-insensitively', () => {
    const q = buildRAGQuery(graph([
      node({ title: 'Recordings' }),
      node({ title: 'recordings' }), // dup (case-insensitive)
    ]));
    expect(q.match(/recordings/gi)?.length).toBe(1);
  });

  it('given an empty graph then returns a generic fallback query', () => {
    expect(buildRAGQuery(graph([]))).toContain('user workflows');
  });
});
