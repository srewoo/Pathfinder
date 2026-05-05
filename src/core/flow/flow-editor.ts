/**
 * In-memory editor for a single Flow. Wraps mutations behind a typed API
 * so the side panel UI doesn't have to manipulate raw flow.steps arrays
 * (which is error-prone — orders must stay contiguous, edits must be
 * tracked for the merge layer, etc.).
 */

import type { Flow, FlowStep } from '../../storage/schemas';

export interface EditorState {
  flow: Flow;
  /** Set of step.order values the user has touched in this session. */
  editedOrders: Set<number>;
}

export function createEditor(flow: Flow): EditorState {
  return { flow: { ...flow, steps: [...flow.steps] }, editedOrders: new Set() };
}

export function updateStep(state: EditorState, order: number, patch: Partial<FlowStep>): EditorState {
  const idx = state.flow.steps.findIndex((s) => s.order === order);
  if (idx < 0) return state;
  const updated = { ...state.flow.steps[idx], ...patch, order };
  const steps = state.flow.steps.slice();
  steps[idx] = updated;
  return {
    flow: { ...state.flow, steps, updatedAt: new Date().toISOString() },
    editedOrders: new Set([...state.editedOrders, order]),
  };
}

export function insertStep(state: EditorState, afterOrder: number, step: Omit<FlowStep, 'order'>): EditorState {
  const idx = state.flow.steps.findIndex((s) => s.order === afterOrder);
  const insertAt = idx < 0 ? state.flow.steps.length : idx + 1;
  const steps = [
    ...state.flow.steps.slice(0, insertAt),
    { ...step, order: -1 }, // placeholder, we renumber below
    ...state.flow.steps.slice(insertAt),
  ];
  const renumbered = renumber(steps);
  return {
    flow: { ...state.flow, steps: renumbered, updatedAt: new Date().toISOString() },
    editedOrders: new Set([...state.editedOrders, renumbered[insertAt].order]),
  };
}

export function deleteStep(state: EditorState, order: number): EditorState {
  const steps = state.flow.steps.filter((s) => s.order !== order);
  const renumbered = renumber(steps);
  return {
    flow: { ...state.flow, steps: renumbered, updatedAt: new Date().toISOString() },
    editedOrders: state.editedOrders, // edited orders track historical edits, no need to update
  };
}

export function moveStep(state: EditorState, order: number, direction: 'up' | 'down'): EditorState {
  const idx = state.flow.steps.findIndex((s) => s.order === order);
  if (idx < 0) return state;
  const swapWith = direction === 'up' ? idx - 1 : idx + 1;
  if (swapWith < 0 || swapWith >= state.flow.steps.length) return state;

  const steps = state.flow.steps.slice();
  [steps[idx], steps[swapWith]] = [steps[swapWith], steps[idx]];
  const renumbered = renumber(steps);
  return {
    flow: { ...state.flow, steps: renumbered, updatedAt: new Date().toISOString() },
    editedOrders: new Set([...state.editedOrders, renumbered[idx].order, renumbered[swapWith].order]),
  };
}

function renumber(steps: FlowStep[]): FlowStep[] {
  return steps.map((s, i) => ({ ...s, order: i + 1 }));
}
