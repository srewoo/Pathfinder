import { describe, it, expect } from 'vitest';
import { diffFlows, mergeFlows } from '../../../src/core/flow/flow-diff';
import type { Flow, FlowStep } from '../../../src/storage/schemas';

const step = (overrides: Partial<FlowStep>): FlowStep => ({
  order: 1, action: 'click', description: 'd', ...overrides,
});

const flow = (steps: FlowStep[], id = 'f1'): Flow => ({
  flowId: id, name: 'n', description: '', steps,
  source: 'exploration', createdAt: '', updatedAt: '',
});

describe('diffFlows', () => {
  it('given identical flows when diffing then all unchanged', () => {
    const f = flow([step({ order: 1, selector: '#a' }), step({ order: 2, selector: '#b' })]);
    const d = diffFlows(f, f);
    expect(d.summary.unchanged).toBe(2);
    expect(d.summary.added + d.summary.removed + d.summary.changed).toBe(0);
  });

  it('given step removed in new flow when diffing then reports removed', () => {
    const before = flow([step({ order: 1, selector: '#a' }), step({ order: 2, selector: '#b' })]);
    const after = flow([step({ order: 1, selector: '#a' })]);
    const d = diffFlows(before, after);
    expect(d.summary.removed).toBe(1);
    expect(d.steps.find((s) => s.kind === 'removed')?.before?.selector).toBe('#b');
  });

  it('given step added in new flow when diffing then reports added', () => {
    const before = flow([step({ order: 1, selector: '#a' })]);
    const after = flow([step({ order: 1, selector: '#a' }), step({ order: 2, selector: '#new' })]);
    const d = diffFlows(before, after);
    expect(d.summary.added).toBe(1);
  });

  it('given description change on same selector when diffing then reports changed', () => {
    const before = flow([step({ order: 1, selector: '#a', description: 'old' })]);
    const after = flow([step({ order: 1, selector: '#a', description: 'new' })]);
    const d = diffFlows(before, after);
    expect(d.summary.changed).toBe(1);
    expect(d.steps[0].changes?.[0].field).toBe('description');
  });

  it('given completely different flows when diffing then all added/removed', () => {
    const before = flow([step({ order: 1, selector: '#a' })]);
    const after = flow([step({ order: 1, selector: '#z' })]);
    const d = diffFlows(before, after);
    expect(d.summary.added).toBe(1);
    expect(d.summary.removed).toBe(1);
  });
});

describe('mergeFlows', () => {
  it('given non-conflicting changes when merging then prefers remote', () => {
    const local = flow([step({ order: 1, selector: '#a', description: 'A' })]);
    const remote = flow([step({ order: 1, selector: '#a', description: 'A-NEW' })]);
    const r = mergeFlows(local, remote);
    expect(r.flow.steps[0].description).toBe('A-NEW');
    expect(r.conflicts).toHaveLength(0);
  });

  it('given user-edited order when remote also changed then keeps local', () => {
    const local = flow([step({ order: 1, selector: '#a', description: 'USER FIX' })]);
    const remote = flow([step({ order: 1, selector: '#a', description: 'remote auto' })]);
    const r = mergeFlows(local, remote, { userEditedOrders: new Set([1]) });
    expect(r.flow.steps[0].description).toBe('USER FIX');
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0].pickedSide).toBe('local');
  });

  it('given remote removes a step when user did not edit it then drops it', () => {
    const local = flow([
      step({ order: 1, selector: '#a' }),
      step({ order: 2, selector: '#b' }),
    ]);
    const remote = flow([step({ order: 1, selector: '#a' })]);
    const r = mergeFlows(local, remote);
    expect(r.flow.steps).toHaveLength(1);
  });

  it('given remote removes a user-edited step when merging then keeps it', () => {
    const local = flow([
      step({ order: 1, selector: '#a' }),
      step({ order: 2, selector: '#b', description: 'USER NOTE' }),
    ]);
    const remote = flow([step({ order: 1, selector: '#a' })]);
    const r = mergeFlows(local, remote, { userEditedOrders: new Set([2]) });
    expect(r.flow.steps).toHaveLength(2);
    expect(r.flow.steps.find((s) => s.order === 2)?.description).toBe('USER NOTE');
  });
});
