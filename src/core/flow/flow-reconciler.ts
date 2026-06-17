import type { Flow } from '../../storage/schemas';
import type { FlowDraft } from './skeleton-enumerator';
import { flowSignature } from './skeleton-enumerator';

/**
 * Phase 3 reconcile: decide what to create, update, or mark stale when
 * "Learn Flows" runs against an app that already has stored flows.
 *
 * Identity is the flow SIGNATURE (hash of its step sequence), NOT its name or
 * flowId. This means:
 *   - A reworded-but-structurally-identical flow updates the existing record
 *     in place — keeping its flowId so already-generated test cases stay linked.
 *   - A flow whose signature is no longer produced is "drift" (its feature was
 *     likely removed) and gets marked stale rather than deleted (reversible).
 *
 * Pure function: takes the freshly-produced drafts + the currently-stored flows
 * and returns a plan. The caller performs the actual DB writes. This keeps the
 * decision logic deterministic and unit-testable with no IndexedDB.
 */

export interface ReconcilePlan {
  /** Drafts with no matching stored signature — create as new flows. */
  toCreate: Array<FlowDraft & { signature: string }>;
  /** Stored flows whose signature reappeared — patch content in place. */
  toUpdate: Array<{ flowId: string; patch: Partial<Flow> }>;
  /** Stored flows whose signature vanished — mark stale (reversible). */
  toMarkStale: string[];
  /** Stored stale flows whose signature reappeared — clear the stale flag. */
  toRevive: string[];
}

/** Sources that reconcile is allowed to mutate. User/manual flows are never touched. */
const RECONCILABLE_SOURCES = new Set<Flow['source']>(['exploration', 'hybrid']);

export function reconcileFlows(drafts: FlowDraft[], existing: Flow[]): ReconcilePlan {
  // Index stored flows by signature (fall back to computing it for legacy flows
  // saved before signatures existed).
  const existingBySig = new Map<string, Flow>();
  for (const flow of existing) {
    const sig = flow.signature ?? flowSignature(flow.steps);
    if (!existingBySig.has(sig)) existingBySig.set(sig, flow);
  }

  const plan: ReconcilePlan = { toCreate: [], toUpdate: [], toMarkStale: [], toRevive: [] };
  const seenSignatures = new Set<string>();

  for (const draft of drafts) {
    const sig = flowSignature(draft.steps);
    if (!sig || seenSignatures.has(sig)) continue; // skip empty + intra-batch dupes
    seenSignatures.add(sig);

    const match = existingBySig.get(sig);
    if (!match) {
      plan.toCreate.push({ ...draft, signature: sig });
      continue;
    }

    // Update content in place. Prefer the draft's richer fields but never
    // downgrade a human-meaningful name to a generated one if unchanged.
    const patch: Partial<Flow> = {
      name: draft.name,
      description: draft.description,
      steps: draft.steps,
      source: draft.source,
      coverageType: draft.coverageType ?? match.coverageType,
      knowledgeRefs: draft.knowledgeRefs ?? match.knowledgeRefs,
      signature: sig,
    };
    plan.toUpdate.push({ flowId: match.flowId, patch });
    if (match.stale) plan.toRevive.push(match.flowId);
  }

  // Drift: reconcilable stored flows whose signature was not produced this run.
  for (const flow of existing) {
    const sig = flow.signature ?? flowSignature(flow.steps);
    if (seenSignatures.has(sig)) continue;
    if (!RECONCILABLE_SOURCES.has(flow.source)) continue;
    if (!flow.stale) plan.toMarkStale.push(flow.flowId);
  }

  return plan;
}

/** Convenience for callers/UI: the patch applied when marking a flow stale. */
export function staleMark(nowIso: string): Partial<Flow> {
  return { stale: true, staleSince: nowIso };
}

/** Convenience for callers/UI: the patch applied when reviving a stale flow. */
export function reviveMark(): Partial<Flow> {
  return { stale: false, staleSince: undefined };
}
