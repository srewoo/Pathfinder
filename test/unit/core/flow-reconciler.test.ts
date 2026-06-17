import { describe, it, expect } from 'vitest';
import { reconcileFlows } from '../../../src/core/flow/flow-reconciler';
import { flowSignature, type FlowDraft } from '../../../src/core/flow/skeleton-enumerator';
import type { Flow, FlowStep } from '../../../src/storage/schemas';

const steps = (...labels: string[]): FlowStep[] =>
  labels.map((l, i) => ({ order: i + 1, action: 'click', selector: `#${l}`, target: l, description: l }));

const draft = (name: string, s: FlowStep[], extra: Partial<FlowDraft> = {}): FlowDraft => ({
  name, description: '', source: 'exploration', steps: s, ...extra,
});

const stored = (name: string, s: FlowStep[], extra: Partial<Flow> = {}): Flow => ({
  flowId: `id_${name}`,
  name,
  description: '',
  source: 'exploration',
  steps: s,
  signature: flowSignature(s),
  createdAt: '', updatedAt: '',
  ...extra,
});

describe('reconcileFlows', () => {
  it('creates flows whose signature is not stored', () => {
    const plan = reconcileFlows([draft('New', steps('a', 'b'))], []);
    expect(plan.toCreate).toHaveLength(1);
    expect(plan.toCreate[0].signature).toBe(flowSignature(steps('a', 'b')));
    expect(plan.toUpdate).toHaveLength(0);
  });

  it('updates in place (keeps flowId) when a signature already exists, even if the name changed', () => {
    const s = steps('login', 'submit');
    const existing = [stored('Old name', s)];
    const plan = reconcileFlows([draft('Reworded name', s, { description: 'better desc' })], existing);

    expect(plan.toCreate).toHaveLength(0);
    expect(plan.toUpdate).toHaveLength(1);
    expect(plan.toUpdate[0].flowId).toBe('id_Old name'); // SAME flowId → test cases stay linked
    expect(plan.toUpdate[0].patch.name).toBe('Reworded name');
    expect(plan.toUpdate[0].patch.description).toBe('better desc');
  });

  it('marks a stored exploration flow stale when its signature is no longer produced (drift)', () => {
    const existing = [stored('Gone feature', steps('x', 'y'))];
    const plan = reconcileFlows([draft('Other', steps('a'))], existing);
    expect(plan.toMarkStale).toEqual(['id_Gone feature']);
  });

  it('never marks user- or documentation-authored flows stale', () => {
    const existing = [
      stored('Doc flow', steps('d'), { source: 'documentation' }),
      stored('Explore flow', steps('e'), { source: 'exploration' }),
    ];
    const plan = reconcileFlows([], existing);
    expect(plan.toMarkStale).toEqual(['id_Explore flow']);
  });

  it('revives a stale flow whose signature reappears', () => {
    const s = steps('feature');
    const existing = [stored('Was stale', s, { stale: true, staleSince: '2026-01-01' })];
    const plan = reconcileFlows([draft('Was stale', s)], existing);
    expect(plan.toUpdate.map((u) => u.flowId)).toContain('id_Was stale');
    expect(plan.toRevive).toContain('id_Was stale');
    expect(plan.toMarkStale).toHaveLength(0);
  });

  it('reconciles legacy stored flows that have no signature field by computing it', () => {
    const s = steps('legacy');
    const legacy = stored('Legacy', s);
    delete (legacy as { signature?: string }).signature;
    const plan = reconcileFlows([draft('Legacy v2', s)], [legacy]);
    expect(plan.toUpdate).toHaveLength(1); // matched by computed signature, not duplicated
    expect(plan.toCreate).toHaveLength(0);
  });

  it('deduplicates structurally-identical drafts within one run', () => {
    const s = steps('dup');
    const plan = reconcileFlows([draft('A', s), draft('B', s)], []);
    expect(plan.toCreate).toHaveLength(1);
  });
});
