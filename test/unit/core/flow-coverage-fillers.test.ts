import { describe, it, expect } from 'vitest';
import { synthesizeCoverageFillers } from '../../../src/core/flow/flow-learner';
import type { InteractionGraph, PageNode, Flow } from '../../../src/storage/schemas';

const node = (partial: Partial<PageNode>): PageNode =>
  ({ id: 'n', url: 'https://app/p', title: 'Page', visitedAt: '', elementCount: 1, ...partial } as PageNode);

const graph = (nodes: PageNode[]): InteractionGraph =>
  ({ nodes, edges: [], createdAt: '', updatedAt: '' } as InteractionGraph);

type PartialFlow = Omit<Flow, 'flowId' | 'createdAt' | 'updatedAt'>;

describe('synthesizeCoverageFillers — feature-tab coverage', () => {
  it('given a page with captured tabs then synthesizes one flow per uncovered tab', () => {
    const g = graph([
      node({
        url: 'https://app/recording/1',
        title: 'Recording',
        tabs: [
          { label: 'Overview', url: 'https://app/recording/1?tab=overview' },
          { label: 'Transcript', url: 'https://app/recording/1?tab=transcript' },
          { label: 'Scorecard', url: 'https://app/recording/1?tab=scorecard' },
        ],
      }),
    ]);

    const fillers = synthesizeCoverageFillers(g, []);
    const tabFlowNames = fillers.map((f) => f.name);
    expect(tabFlowNames).toEqual(expect.arrayContaining([
      'Open Overview (Recording)',
      'Open Transcript (Recording)',
      'Open Scorecard (Recording)',
    ]));
    // Each tab flow navigates to that tab's full URL.
    const transcript = fillers.find((f) => f.name === 'Open Transcript (Recording)');
    expect(transcript?.steps[0].value).toBe('https://app/recording/1?tab=transcript');
  });

  it('given a tab already referenced by an existing flow then it is NOT duplicated', () => {
    const g = graph([
      node({ url: 'https://app/recording/1', tabs: [{ label: 'Transcript', url: 'https://app/recording/1?tab=transcript' }] }),
    ]);
    const existing: PartialFlow[] = [
      { name: 'View transcript', description: '', source: 'hybrid', steps: [
        { order: 1, action: 'navigate', value: 'https://app/recording/1?tab=transcript', description: 'open' } as never,
      ] },
    ];
    const fillers = synthesizeCoverageFillers(g, existing);
    expect(fillers.some((f) => f.name.includes('Open Transcript'))).toBe(false);
  });

  it('given a page with no tabs then only page-level fillers are produced', () => {
    const fillers = synthesizeCoverageFillers(graph([node({ url: 'https://app/plain', title: 'Plain' })]), []);
    expect(fillers.every((f) => !f.name.startsWith('Open '))).toBe(true);
    expect(fillers.length).toBeGreaterThan(0); // page coverage fillers still made
  });
});
