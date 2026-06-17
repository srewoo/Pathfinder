import { describe, it, expect } from 'vitest';
import {
  enumerateSkeletons,
  dedupeBySignature,
  flowSignature,
  type FlowDraft,
} from '../../../src/core/flow/skeleton-enumerator';
import type { InteractionGraph, PageNode, PageEdge, FlowStep } from '../../../src/storage/schemas';

const node = (partial: Partial<PageNode>): PageNode =>
  ({ id: partial.url ?? 'n', url: 'https://app/p', title: 'Page', visitedAt: '', elementCount: 1, ...partial } as PageNode);

const edge = (from: string, to: string, label: string, selector: string): PageEdge =>
  ({ from, to, action: 'click', label, selector });

const graph = (nodes: PageNode[], edges: PageEdge[] = []): InteractionGraph =>
  ({ nodes, edges, createdAt: '', updatedAt: '' });

describe('flowSignature — structural identity', () => {
  it('given two flows with the same action+target sequence then signatures match', () => {
    const a: FlowStep[] = [
      { order: 1, action: 'navigate', value: 'https://app/x', description: 'open' },
      { order: 2, action: 'click', selector: '#btn', target: 'Save', description: 'click save' },
    ];
    const b: FlowStep[] = [
      { order: 1, action: 'NAVIGATE', value: 'https://app/x', description: 'go' },
      { order: 2, action: 'click', selector: '#btn', target: 'Submit', description: 'press' },
    ];
    // Same selector for the click → same signature even though target text differs.
    expect(flowSignature(a)).toBe(flowSignature(b));
  });

  it('given differing query params then signatures differ (tabs stay distinct)', () => {
    const overview: FlowStep[] = [{ order: 1, action: 'navigate', value: 'https://app/r?tab=overview', description: '' }];
    const transcript: FlowStep[] = [{ order: 1, action: 'navigate', value: 'https://app/r?tab=transcript', description: '' }];
    expect(flowSignature(overview)).not.toBe(flowSignature(transcript));
  });
});

describe('dedupeBySignature', () => {
  it('keeps the first occurrence and drops structural duplicates', () => {
    const flows: FlowDraft[] = [
      { name: 'Rich LLM flow', description: 'd', source: 'hybrid', steps: [{ order: 1, action: 'navigate', value: 'https://app/x', description: '' }] },
      { name: 'Skeleton dupe', description: 'd', source: 'exploration', steps: [{ order: 1, action: 'navigate', value: 'https://app/x', description: '' }] },
    ];
    const out = dedupeBySignature(flows);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Rich LLM flow');
  });

  it('drops flows with no steps', () => {
    expect(dedupeBySignature([{ name: 'empty', description: '', source: 'exploration', steps: [] }])).toHaveLength(0);
  });
});

describe('enumerateSkeletons — graph-first completeness', () => {
  it('enumerates multi-hop navigation journeys from an entry page', () => {
    const g = graph(
      [
        node({ url: 'https://app/home', title: 'Home' }),
        node({ url: 'https://app/reports', title: 'Reports' }),
        node({ url: 'https://app/reports/1', title: 'Report Detail' }),
      ],
      [
        edge('https://app/home', 'https://app/reports', 'Reports', '#nav-reports'),
        edge('https://app/reports', 'https://app/reports/1', 'Open', '#row-1'),
      ]
    );
    const skeletons = enumerateSkeletons(g);
    const names = skeletons.map((s) => s.name);
    // A journey reaching the deepest page should exist.
    expect(names.some((n) => n.includes('Home → Reports → Report Detail'))).toBe(true);
  });

  it('emits a happy-path AND a negative-path flow for a form with required fields', () => {
    const g = graph([
      node({
        url: 'https://app/login',
        title: 'Login',
        formFields: [
          { selector: '#email', type: 'email', label: 'Email', required: true },
          { selector: '#pwd', type: 'password', label: 'Password', required: true },
        ],
        formOutcomes: [{ filledFields: ['#email', '#pwd'], submitSelector: '#submit', result: 'navigation', resultUrl: 'https://app/dashboard' }],
      }),
    ]);
    const skeletons = enumerateSkeletons(g);
    expect(skeletons.some((s) => s.name === 'Submit form: Login')).toBe(true);
    expect(skeletons.some((s) => s.name.startsWith('Validation:'))).toBe(true);

    const happy = skeletons.find((s) => s.name === 'Submit form: Login')!;
    // Fills both required fields, then submits with the captured submit selector.
    expect(happy.steps.some((st) => st.selector === '#email' && st.action === 'type')).toBe(true);
    expect(happy.steps.some((st) => st.selector === '#submit')).toBe(true);
    // Outcome expectation reflects the captured navigation.
    expect(happy.steps.at(-1)?.expectedOutcome).toContain('https://app/dashboard');
  });

  it('does NOT emit a negative path when no fields are required', () => {
    const g = graph([
      node({ url: 'https://app/search', title: 'Search', formFields: [{ selector: '#q', type: 'text', label: 'Query', required: false }] }),
    ]);
    const skeletons = enumerateSkeletons(g);
    expect(skeletons.some((s) => s.name === 'Submit form: Search')).toBe(true);
    expect(skeletons.some((s) => s.name.startsWith('Validation:'))).toBe(false);
  });

  it('emits a flow per captured feature tab', () => {
    const g = graph([
      node({
        url: 'https://app/r/1',
        title: 'Recording',
        tabs: [
          { label: 'Overview', url: 'https://app/r/1?tab=overview' },
          { label: 'Transcript', url: 'https://app/r/1?tab=transcript' },
        ],
      }),
    ]);
    const skeletons = enumerateSkeletons(g);
    expect(skeletons.some((s) => s.name === 'Open Overview (Recording)')).toBe(true);
    expect(skeletons.some((s) => s.name === 'Open Transcript (Recording)')).toBe(true);
  });

  it('emits a modal-open flow per captured modal', () => {
    const g = graph([
      node({
        url: 'https://app/users',
        title: 'Users',
        modals: [{ triggerSelector: '#add', triggerLabel: 'Add User', title: 'New User' }],
      }),
    ]);
    const skeletons = enumerateSkeletons(g);
    const modal = skeletons.find((s) => s.name.includes('Add User'));
    expect(modal).toBeDefined();
    expect(modal!.steps.some((st) => st.selector === '#add')).toBe(true);
  });

  it('emits a row-action flow per captured data-table row action', () => {
    const g = graph([
      node({
        url: 'https://app/orders',
        title: 'Orders',
        dataTables: [{ selector: 'table', rowCount: 10, hasPagination: true, hasSorting: true, hasFiltering: true, rowActions: ['Edit', 'Delete'] }],
      }),
    ]);
    const skeletons = enumerateSkeletons(g);
    expect(skeletons.some((s) => s.name === 'Edit row in Orders')).toBe(true);
    expect(skeletons.some((s) => s.name === 'Delete row in Orders')).toBe(true);
  });

  it('emits a boundary flow for a field with a maxLength constraint', () => {
    const g = graph([
      node({
        url: 'https://app/profile',
        title: 'Profile',
        formFields: [{ selector: '#bio', type: 'text', label: 'Bio', required: true, maxLength: 10 }],
      }),
    ]);
    const skeletons = enumerateSkeletons(g);
    const boundary = skeletons.find((s) => s.coverageType === 'boundary');
    expect(boundary).toBeDefined();
    expect(boundary!.name).toContain('Bio');
    // The injected value exceeds the 10-char max.
    const fillStep = boundary!.steps.find((st) => st.selector === '#bio');
    expect(fillStep?.value?.length).toBeGreaterThan(10);
  });

  it('emits an empty-state flow only for a zero-row table', () => {
    const g = graph([
      node({ url: 'https://app/inbox', title: 'Inbox', dataTables: [{ selector: 't', rowCount: 0, hasPagination: false, hasSorting: false, hasFiltering: false }] }),
    ]);
    const skeletons = enumerateSkeletons(g);
    expect(skeletons.some((s) => s.coverageType === 'empty' && s.name === 'Empty state: Inbox')).toBe(true);
  });

  it('tags every skeleton with a coverageType from the matrix', () => {
    const g = graph(
      [
        node({ url: 'https://app/a', title: 'A' }),
        node({ url: 'https://app/b', title: 'B', formFields: [{ selector: '#n', type: 'text', label: 'Name', required: true }] }),
      ],
      [edge('https://app/a', 'https://app/b', 'Go', '#go')]
    );
    const skeletons = enumerateSkeletons(g);
    expect(skeletons.length).toBeGreaterThan(0);
    expect(skeletons.every((s) => typeof s.coverageType === 'string')).toBe(true);
  });

  it('returns no skeletons for an empty graph', () => {
    expect(enumerateSkeletons(undefined)).toHaveLength(0);
    expect(enumerateSkeletons(graph([]))).toHaveLength(0);
  });

  it('output is internally structurally de-duplicated', () => {
    const skeletons = enumerateSkeletons(
      graph([node({ url: 'https://app/r', title: 'R', tabs: [{ label: 'A', url: 'https://app/r?t=a' }, { label: 'A', url: 'https://app/r?t=a' }] })])
    );
    const sigs = skeletons.map((s) => flowSignature(s.steps));
    expect(new Set(sigs).size).toBe(sigs.length);
  });
});
