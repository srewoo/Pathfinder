/**
 * Flow diff & merge utilities.
 *
 * Why: when an app changes, previously-learned flows can break (steps
 * removed, selectors changed, new steps inserted). Re-running flow
 * extraction produces a fresh Flow but loses the link to the old one.
 *
 * `diffFlows` aligns two flows step-by-step using a longest-common-subsequence
 * walk and reports added/removed/changed steps. `mergeFlows` resolves a 3-way
 * merge between an old saved flow, a new auto-extracted flow, and any user
 * edits, biasing toward user changes when they conflict with auto-extraction.
 */

import type { Flow, FlowStep } from '../../storage/schemas';

export interface StepDiff {
  /** What kind of change. */
  kind: 'added' | 'removed' | 'changed' | 'unchanged';
  /** Step from the previous flow (undefined when added). */
  before?: FlowStep;
  /** Step from the new flow (undefined when removed). */
  after?: FlowStep;
  /** Field-level diff when kind is 'changed'. */
  changes?: Array<{ field: keyof FlowStep; before: unknown; after: unknown }>;
}

export interface FlowDiff {
  flowId: string;
  /** Step-level diff in order of the new flow. */
  steps: StepDiff[];
  /** Counts for quick UI summary. */
  summary: { added: number; removed: number; changed: number; unchanged: number };
}

const TRACKED_FIELDS: Array<keyof FlowStep> = [
  'action', 'target', 'value', 'selector', 'description', 'expectedOutcome',
];

export function diffFlows(before: Flow, after: Flow): FlowDiff {
  const steps = lcsAlign(before.steps, after.steps);
  const summary = { added: 0, removed: 0, changed: 0, unchanged: 0 };
  for (const s of steps) summary[s.kind]++;
  return { flowId: after.flowId, steps, summary };
}

/**
 * Three-way merge: pick the user's edits when they conflict with the
 * automatically-extracted update. Ensures regenerating flows doesn't blow
 * away a manual fix the user made earlier.
 */
export interface MergeOptions {
  /** Steps the user manually edited in `local`. Indexed by step.order. */
  userEditedOrders?: Set<number>;
}

export interface MergeResult {
  flow: Flow;
  conflicts: Array<{
    order: number;
    localValue: FlowStep;
    remoteValue: FlowStep;
    pickedSide: 'local' | 'remote';
  }>;
}

export function mergeFlows(local: Flow, remote: Flow, opts: MergeOptions = {}): MergeResult {
  const conflicts: MergeResult['conflicts'] = [];
  const edited = opts.userEditedOrders ?? new Set<number>();
  const localByOrder = new Map(local.steps.map((s) => [s.order, s]));
  const remoteByOrder = new Map(remote.steps.map((s) => [s.order, s]));

  // Union of orders, preserving remote order
  const allOrders = new Set<number>();
  for (const s of remote.steps) allOrders.add(s.order);
  for (const s of local.steps) allOrders.add(s.order);

  const merged: FlowStep[] = [];
  for (const order of [...allOrders].sort((a, b) => a - b)) {
    const l = localByOrder.get(order);
    const r = remoteByOrder.get(order);

    if (l && r) {
      if (stepsEqual(l, r)) {
        merged.push(r);
      } else if (edited.has(order)) {
        conflicts.push({ order, localValue: l, remoteValue: r, pickedSide: 'local' });
        merged.push(l);
      } else {
        merged.push(r);
      }
    } else if (l && !r) {
      // Removed remotely; keep local only if user-edited
      if (edited.has(order)) merged.push(l);
    } else if (!l && r) {
      merged.push(r);
    }
  }

  return {
    flow: {
      ...remote,
      steps: merged,
      updatedAt: new Date().toISOString(),
    },
    conflicts,
  };
}

// ─── Internals ──────────────────────────────────────────────────────────────

function stepsEqual(a: FlowStep, b: FlowStep): boolean {
  for (const f of TRACKED_FIELDS) {
    if (a[f] !== b[f]) return false;
  }
  return true;
}

function stepKey(s: FlowStep): string {
  // Pair selector + action since identical actions on different selectors are
  // semantically distinct. Description is too volatile to use as a key.
  return `${s.action}::${s.selector ?? s.target ?? ''}`;
}

/** Longest-common-subsequence alignment of two step arrays. */
function lcsAlign(before: FlowStep[], after: FlowStep[]): StepDiff[] {
  const m = before.length;
  const n = after.length;
  // dp[i][j] = LCS length for before[0..i) vs after[0..j)
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      if (stepKey(before[i]) === stepKey(after[j])) {
        dp[i + 1][j + 1] = dp[i][j] + 1;
      } else {
        dp[i + 1][j + 1] = Math.max(dp[i][j + 1], dp[i + 1][j]);
      }
    }
  }

  // Walk back to produce diff
  const out: StepDiff[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (stepKey(before[i - 1]) === stepKey(after[j - 1])) {
      const changes = stepFieldDiff(before[i - 1], after[j - 1]);
      if (changes.length === 0) {
        out.unshift({ kind: 'unchanged', before: before[i - 1], after: after[j - 1] });
      } else {
        out.unshift({ kind: 'changed', before: before[i - 1], after: after[j - 1], changes });
      }
      i--; j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      out.unshift({ kind: 'removed', before: before[i - 1] });
      i--;
    } else {
      out.unshift({ kind: 'added', after: after[j - 1] });
      j--;
    }
  }
  while (i > 0) { out.unshift({ kind: 'removed', before: before[i - 1] }); i--; }
  while (j > 0) { out.unshift({ kind: 'added', after: after[j - 1] }); j--; }

  return out;
}

function stepFieldDiff(a: FlowStep, b: FlowStep): StepDiff['changes'] {
  const changes: NonNullable<StepDiff['changes']> = [];
  for (const f of TRACKED_FIELDS) {
    if (a[f] !== b[f]) changes.push({ field: f, before: a[f], after: b[f] });
  }
  return changes;
}
