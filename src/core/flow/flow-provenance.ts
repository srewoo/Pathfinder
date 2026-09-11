/**
 * Where a flow's claims come from, kept as three separate dimensions.
 *
 * Collapsing them is the failure this module exists to prevent. A flow can be:
 *
 *   · **observed** — its steps correspond to actions the explorer actually
 *     performed against the app;
 *   · **documented** — its expectations are backed by retrieved documentation;
 *   · **replay-validated** — a test generated from it was executed and passed.
 *
 * These are independent. A flow enumerated from the interaction graph is
 * observed and nothing more; generating a test from it adds no evidence
 * whatsoever, and neither does the test existing unexecuted. The only thing
 * that makes a flow replay-validated is a run that passed — and only while the
 * flow still has the shape that run exercised.
 *
 * That last clause is the other half. A flow's `signature` is a hash of its
 * step structure; when a re-learn changes it, the passing run belongs to a
 * different flow than the one now on screen, and the validation has to lapse
 * rather than carry over. Otherwise the most reassuring label in the product is
 * the one most likely to be out of date.
 */
import type { Flow, TestCase, TestResult } from '../../storage/schemas';

export type ReplayStatus =
  /** No test generated from this flow has ever been executed. */
  | { kind: 'never-run' }
  /** A run passed, and the flow still has the shape that run exercised. */
  | { kind: 'validated'; at: string; runId: string; testCaseId: string }
  /** The most recent run of this flow's tests failed. */
  | { kind: 'failed'; at: string; runId: string; testCaseId: string }
  /**
   * A run passed, but the flow's structure has changed since. The evidence is
   * real and no longer applies — which is a different thing from never having
   * run, and a user deciding what to re-run needs to tell them apart.
   */
  | { kind: 'stale'; at: string; runId: string; testCaseId: string };

export interface FlowProvenance {
  /** Steps that correspond to actions recorded during exploration. */
  observedSteps: number;
  /**
   * Steps with no counterpart in the exploration graph — the model's own
   * additions. Not automatically wrong; automatically unverified.
   */
  inferredSteps: number;
  totalSteps: number;
  /** Documentation chunks backing this flow. Zero means nothing backs it. */
  documentationRefs: number;
  replay: ReplayStatus;
}

/**
 * Step targets the explorer actually interacted with, keyed for lookup.
 *
 * Built from the graph's edges rather than its nodes: an edge is the record of
 * an action having been performed, which is precisely the claim being checked.
 */
export function observedActionKeys(edges: ReadonlyArray<{ from: string; selector: string }>): Set<string> {
  return new Set(edges.map((e) => `${e.from}::${e.selector}`));
}

function stepKey(startUrl: string | undefined, target: string | undefined): string {
  return `${startUrl ?? ''}::${target ?? ''}`;
}

/**
 * Split a flow's steps into observed and inferred.
 *
 * A `navigate` step is neither: it is how a flow gets to where the work
 * happens, and counting it as an observed action would inflate every flow's
 * evidence by its own setup.
 */
export function countStepProvenance(
  flow: Pick<Flow, 'steps' | 'startUrl'>,
  observed: Set<string>
): { observedSteps: number; inferredSteps: number; totalSteps: number } {
  let observedSteps = 0;
  let inferredSteps = 0;

  for (const step of flow.steps) {
    if (step.action === 'navigate') continue;
    if (observed.has(stepKey(flow.startUrl, step.target))) observedSteps += 1;
    else inferredSteps += 1;
  }

  return { observedSteps, inferredSteps, totalSteps: observedSteps + inferredSteps };
}

/**
 * The replay status of a flow, from the runs of the tests generated from it.
 *
 * Only executed runs count. A generated test that has never run contributes
 * nothing, which is the rule the whole module turns on.
 */
export function replayStatusFor(
  flow: Pick<Flow, 'flowId' | 'signature'>,
  tests: ReadonlyArray<Pick<TestCase, 'id' | 'sourceFlowId' | 'flowSignature'>>,
  results: ReadonlyArray<Pick<TestResult, 'testCaseId' | 'status' | 'completedAt' | 'startedAt' | 'runId'>>
): ReplayStatus {
  const linked = new Map(
    tests.filter((t) => t.sourceFlowId === flow.flowId).map((t) => [t.id, t])
  );
  if (linked.size === 0) return { kind: 'never-run' };

  const relevant = results
    .filter((r) => linked.has(r.testCaseId))
    // 'running' is not an outcome, and treating it as one would let an
    // in-flight run read as evidence either way.
    .filter((r) => r.status === 'passed' || r.status === 'failed' || r.status === 'error')
    .sort((a, b) => (b.completedAt ?? b.startedAt).localeCompare(a.completedAt ?? a.startedAt));

  if (relevant.length === 0) return { kind: 'never-run' };

  const latestPass = relevant.find((r) => r.status === 'passed');
  const latest = relevant[0];

  if (!latestPass) {
    return {
      kind: 'failed',
      at: latest.completedAt ?? latest.startedAt,
      runId: latest.runId,
      testCaseId: latest.testCaseId,
    };
  }

  const at = latestPass.completedAt ?? latestPass.startedAt;
  const evidence = {
    at,
    runId: latestPass.runId,
    testCaseId: latestPass.testCaseId,
  };

  // The flow may have been re-learnt into a different shape since the run. The
  // test carries the signature it was generated against; a mismatch means the
  // passing run exercised a flow that no longer exists in this form.
  const ranAgainst = linked.get(latestPass.testCaseId)?.flowSignature;
  if (flow.signature && ranAgainst && ranAgainst !== flow.signature) {
    return { kind: 'stale', ...evidence };
  }

  return { kind: 'validated', ...evidence };
}

export function flowProvenance(
  flow: Flow,
  args: {
    edges: ReadonlyArray<{ from: string; selector: string }>;
    tests: ReadonlyArray<Pick<TestCase, 'id' | 'sourceFlowId' | 'flowSignature'>>;
    results: ReadonlyArray<Pick<TestResult, 'testCaseId' | 'status' | 'completedAt' | 'startedAt' | 'runId'>>;
  }
): FlowProvenance {
  const counts = countStepProvenance(flow, observedActionKeys(args.edges));
  return {
    ...counts,
    documentationRefs: flow.knowledgeRefs?.length ?? 0,
    replay: replayStatusFor(flow, args.tests, args.results),
  };
}

/** One line per dimension, for a UI that must not merge them back together. */
export function describeProvenance(p: FlowProvenance): {
  observed: string;
  documented: string;
  replay: string;
} {
  return {
    observed:
      p.totalSteps === 0
        ? 'No actionable steps.'
        : `${p.observedSteps} of ${p.totalSteps} step${p.totalSteps === 1 ? '' : 's'} were observed during exploration` +
          (p.inferredSteps > 0 ? `; ${p.inferredSteps} inferred and unverified.` : '.'),
    documented:
      p.documentationRefs > 0
        ? `Backed by ${p.documentationRefs} documentation passage${p.documentationRefs === 1 ? '' : 's'}.`
        : 'No documentation backs this flow — its expectations are inferred.',
    replay: describeReplay(p.replay),
  };
}

function describeReplay(status: ReplayStatus): string {
  switch (status.kind) {
    case 'never-run':
      return 'Never replayed. Generating a test is not evidence that the flow works.';
    case 'validated':
      return `Replayed successfully on ${new Date(status.at).toLocaleDateString()}.`;
    case 'failed':
      return `The last replay failed on ${new Date(status.at).toLocaleDateString()}.`;
    case 'stale':
      return `Last passed on ${new Date(status.at).toLocaleDateString()}, but the flow's steps have changed since — that result no longer applies.`;
  }
}
