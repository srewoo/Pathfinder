import { describe, it, expect } from 'vitest';
import {
  createEditor, updateStep, insertStep, deleteStep, moveStep,
} from '../../../src/core/flow/flow-editor';
import type { Flow, FlowStep } from '../../../src/storage/schemas';

const step = (overrides: Partial<FlowStep>): FlowStep => ({
  order: 1, action: 'click', description: 'd', ...overrides,
});

const flow = (steps: FlowStep[]): Flow => ({
  flowId: 'f1', name: 'n', description: '', steps,
  source: 'exploration', createdAt: '', updatedAt: '',
});

describe('flow-editor', () => {
  it('given updateStep when called then patches and tracks order as edited', () => {
    const e = createEditor(flow([step({ order: 1, description: 'old' })]));
    const next = updateStep(e, 1, { description: 'new' });
    expect(next.flow.steps[0].description).toBe('new');
    expect(next.editedOrders.has(1)).toBe(true);
  });

  it('given updateStep on missing order when called then no-op', () => {
    const e = createEditor(flow([step({ order: 1 })]));
    const next = updateStep(e, 99, { description: 'x' });
    expect(next).toBe(e);
  });

  it('given insertStep when called then renumbers and tracks new order', () => {
    const e = createEditor(flow([step({ order: 1 }), step({ order: 2 })]));
    const next = insertStep(e, 1, { action: 'type', description: 'inserted' });
    expect(next.flow.steps).toHaveLength(3);
    expect(next.flow.steps[1].description).toBe('inserted');
    expect(next.flow.steps.map((s) => s.order)).toEqual([1, 2, 3]);
    expect(next.editedOrders.has(2)).toBe(true);
  });

  it('given deleteStep when called then removes and renumbers contiguously', () => {
    const e = createEditor(flow([
      step({ order: 1 }), step({ order: 2 }), step({ order: 3 }),
    ]));
    const next = deleteStep(e, 2);
    expect(next.flow.steps).toHaveLength(2);
    expect(next.flow.steps.map((s) => s.order)).toEqual([1, 2]);
  });

  it('given moveStep up when called then swaps with previous', () => {
    const e = createEditor(flow([
      step({ order: 1, description: 'first' }),
      step({ order: 2, description: 'second' }),
    ]));
    const next = moveStep(e, 2, 'up');
    expect(next.flow.steps[0].description).toBe('second');
    expect(next.flow.steps[1].description).toBe('first');
  });

  it('given moveStep at top when up requested then no-op', () => {
    const e = createEditor(flow([step({ order: 1 }), step({ order: 2 })]));
    const next = moveStep(e, 1, 'up');
    expect(next).toBe(e);
  });

  it('given moveStep at bottom when down requested then no-op', () => {
    const e = createEditor(flow([step({ order: 1 }), step({ order: 2 })]));
    const next = moveStep(e, 2, 'down');
    expect(next).toBe(e);
  });
});
