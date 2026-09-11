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

/**
 * T09 item 4: the second filler per page has to be a second JOURNEY.
 *
 * The old fallback navigated to a URL and then asserted the URL was that URL.
 * It passed unconditionally, could not fail for any reason a user would care
 * about, and doubled the flow count for every page in the graph — quantity
 * reported as coverage.
 */
describe('synthesizeCoverageFillers — a second flow must be worth having', () => {
  it('given a page with nothing to exercise then no tautological url flow is produced', () => {
    const fillers = synthesizeCoverageFillers(
      graph([node({ url: 'https://app/plain', title: 'Plain' })]),
      []
    );

    expect(fillers.some((f) => f.name.startsWith('Load:'))).toBe(false);
  });

  it('given a page with nothing to exercise then it still gets its inspect flow', () => {
    const fillers = synthesizeCoverageFillers(
      graph([node({ url: 'https://app/plain', title: 'Plain' })]),
      []
    );

    expect(fillers.filter((f) => f.name.startsWith('Inspect:'))).toHaveLength(1);
  });

  // A form is a real second journey: a user has to be able to reach and fill it.
  it('given a page with a form then the second flow checks the form is usable', () => {
    const fillers = synthesizeCoverageFillers(
      graph([
        node({
          url: 'https://app/signup',
          title: 'Sign up',
          formFields: [
            { selector: '#email', label: 'Email', type: 'email', required: true } as never,
          ],
        }),
      ]),
      []
    );

    const form = fillers.find((f) => f.name.startsWith('Form on'));
    expect(form?.steps.some((s) => s.description.includes('Email'))).toBe(true);
  });

  it('given a page with a listing then the second flow checks it is populated', () => {
    const fillers = synthesizeCoverageFillers(
      graph([
        node({
          url: 'https://app/orders',
          title: 'Orders',
          dataTables: [
            { selector: 'table', rowCount: 12, hasPagination: false, hasSorting: true } as never,
          ],
        }),
      ]),
      []
    );

    expect(fillers.some((f) => f.name.startsWith('Data on'))).toBe(true);
  });

  // A real action beats both — it is the page doing something.
  it('given a page with a primary action then that action is preferred over the form check', () => {
    const fillers = synthesizeCoverageFillers(
      graph([
        node({
          url: 'https://app/orders',
          title: 'Orders',
          actions: [{ label: 'New order', selector: '#new', kind: 'action' } as never],
          formFields: [{ selector: '#q', label: 'Search', type: 'text' } as never],
        }),
      ]),
      []
    );

    expect(fillers.some((f) => f.name.startsWith('Action: New order'))).toBe(true);
    expect(fillers.some((f) => f.name.startsWith('Form on'))).toBe(false);
  });
});
