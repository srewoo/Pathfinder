/**
 * T09 items 1, 2 and 5: three dimensions that must not collapse into one.
 *
 * The rule under test is the one in item 2, stated as a prohibition: a flow is
 * never replay-validated merely because its steps exist in a graph, or because
 * tests were generated from it. Only an executed, passing run counts — and only
 * while the flow still has the shape that run exercised.
 */
import { describe, it, expect } from 'vitest';
import {
  flowProvenance,
  countStepProvenance,
  observedActionKeys,
  replayStatusFor,
  describeProvenance,
} from '../../../src/core/flow/flow-provenance';
import type { Flow, TestCase, TestResult } from '../../../src/storage/schemas';

const START = 'https://app.test/orders';

function flow(over: Partial<Flow> = {}): Flow {
  return {
    flowId: 'f1',
    name: 'Place an order',
    description: '',
    startUrl: START,
    signature: 'sig-1',
    source: 'exploration',
    steps: [
      { action: 'navigate', target: undefined, value: START },
      { action: 'click', target: '#checkout' },
      { action: 'click', target: '#confirm' },
    ],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  } as Flow;
}

function test(over: Partial<TestCase> = {}): TestCase {
  return {
    id: 't1',
    title: 'Place an order',
    description: '',
    type: 'positive',
    sourceFlowId: 'f1',
    flowSignature: 'sig-1',
    source: 'generated',
    status: 'pending',
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  } as TestCase;
}

function result(over: Partial<TestResult> = {}): TestResult {
  return {
    id: 'r1',
    testCaseId: 't1',
    testCaseTitle: 'Place an order',
    status: 'passed',
    startedAt: '2026-02-01T00:00:00Z',
    completedAt: '2026-02-01T00:01:00Z',
    steps: [],
    healingAttempts: [],
    runId: 'run-1',
    ...over,
  } as TestResult;
}

const EDGES = [
  { from: START, selector: '#checkout' },
  { from: START, selector: '#confirm' },
];

describe('observed steps are the ones the explorer actually performed', () => {
  it('given_every_step_matches_a_recorded_edge_then_none_are_inferred', () => {
    const counts = countStepProvenance(flow(), observedActionKeys(EDGES));

    expect(counts).toEqual({ observedSteps: 2, inferredSteps: 0, totalSteps: 2 });
  });

  it('given_a_step_with_no_matching_edge_then_it_counts_as_inferred', () => {
    const counts = countStepProvenance(flow(), observedActionKeys([EDGES[0]]));

    expect(counts).toEqual({ observedSteps: 1, inferredSteps: 1, totalSteps: 2 });
  });

  // Counting the navigate that gets the flow to its start page would let every
  // flow claim evidence for its own setup.
  it('given_a_navigate_step_then_it_is_counted_as_neither', () => {
    expect(countStepProvenance(flow(), observedActionKeys(EDGES)).totalSteps).toBe(2);
  });

  it('given_an_edge_on_a_different_page_then_it_does_not_vouch_for_this_step', () => {
    const elsewhere = [{ from: 'https://app.test/other', selector: '#checkout' }];

    expect(countStepProvenance(flow(), observedActionKeys(elsewhere)).observedSteps).toBe(0);
  });
});

describe('replay validation requires a run that actually happened', () => {
  // The exact prohibition from the plan.
  it('given_a_generated_test_that_never_ran_then_the_flow_is_not_validated', () => {
    expect(replayStatusFor(flow(), [test()], [])).toEqual({ kind: 'never-run' });
  });

  it('given_no_tests_at_all_then_the_flow_is_not_validated', () => {
    expect(replayStatusFor(flow(), [], [])).toEqual({ kind: 'never-run' });
  });

  it('given_a_passing_run_then_the_flow_is_validated_with_its_evidence', () => {
    expect(replayStatusFor(flow(), [test()], [result()])).toEqual({
      kind: 'validated',
      at: '2026-02-01T00:01:00Z',
      runId: 'run-1',
      testCaseId: 't1',
    });
  });

  it('given_only_failing_runs_then_the_flow_reports_the_failure', () => {
    const status = replayStatusFor(flow(), [test()], [result({ status: 'failed' })]);

    expect(status).toMatchObject({ kind: 'failed', runId: 'run-1' });
  });

  it('given_a_run_still_in_flight_then_it_is_not_treated_as_an_outcome', () => {
    const status = replayStatusFor(flow(), [test()], [result({ status: 'running' })]);

    expect(status).toEqual({ kind: 'never-run' });
  });

  it('given_a_run_of_another_flows_test_then_it_does_not_validate_this_flow', () => {
    const other = test({ id: 't2', sourceFlowId: 'f2' });

    expect(replayStatusFor(flow(), [other], [result({ testCaseId: 't2' })])).toEqual({
      kind: 'never-run',
    });
  });
});

describe('validation lapses when the flow changes under it', () => {
  // The evidence is real; it just no longer describes this flow.
  it('given_the_flow_signature_changed_since_the_passing_run_then_it_is_stale', () => {
    const status = replayStatusFor(flow({ signature: 'sig-2' }), [test()], [result()]);

    expect(status).toMatchObject({ kind: 'stale', runId: 'run-1' });
  });

  it('given_a_stale_result_then_it_is_still_distinguishable_from_never_having_run', () => {
    const status = replayStatusFor(flow({ signature: 'sig-2' }), [test()], [result()]);

    expect(status.kind).not.toBe('never-run');
  });

  // Legacy and user-authored tests carry no signature; absent evidence of a
  // change must not be read as evidence of one.
  it('given_a_test_without_a_pinned_signature_then_the_pass_still_counts', () => {
    const legacy = test({ flowSignature: undefined });

    expect(replayStatusFor(flow({ signature: 'sig-2' }), [legacy], [result()]).kind).toBe('validated');
  });

  it('given_a_later_failure_after_an_earlier_pass_then_the_pass_is_still_reported', () => {
    // The flow has been shown to work; a later failure is a regression, and
    // both facts matter. The pass is what this status reports, and the run
    // history carries the rest.
    const status = replayStatusFor(
      flow(),
      [test()],
      [result(), result({ id: 'r2', status: 'failed', completedAt: '2026-03-01T00:00:00Z', runId: 'run-2' })]
    );

    expect(status).toMatchObject({ kind: 'validated', runId: 'run-1' });
  });
});

describe('documentation backing is reported separately', () => {
  it('given_no_knowledge_refs_then_the_flow_is_reported_as_undocumented', () => {
    const p = flowProvenance(flow(), { edges: EDGES, tests: [], results: [] });

    expect(p.documentationRefs).toBe(0);
    expect(describeProvenance(p).documented).toMatch(/no documentation/i);
  });

  it('given_knowledge_refs_then_they_are_counted', () => {
    const grounded = flow({
      knowledgeRefs: [{ url: 'https://docs.test/a', score: 0.7 }],
    });

    expect(flowProvenance(grounded, { edges: EDGES, tests: [], results: [] }).documentationRefs).toBe(1);
  });

  // Documentation backing says nothing about whether the flow runs.
  it('given_a_documented_flow_that_never_ran_then_it_is_still_not_validated', () => {
    const grounded = flow({ knowledgeRefs: [{ url: 'https://docs.test/a', score: 0.9 }] });

    expect(flowProvenance(grounded, { edges: EDGES, tests: [test()], results: [] }).replay).toEqual({
      kind: 'never-run',
    });
  });
});

describe('the description keeps the three dimensions apart', () => {
  it('given_an_unrun_flow_then_the_replay_line_says_generation_is_not_evidence', () => {
    const p = flowProvenance(flow(), { edges: EDGES, tests: [test()], results: [] });

    expect(describeProvenance(p).replay).toMatch(/not evidence/i);
  });

  it('given_inferred_steps_then_the_observed_line_names_them', () => {
    const p = flowProvenance(flow(), { edges: [EDGES[0]], tests: [], results: [] });

    expect(describeProvenance(p).observed).toMatch(/1 inferred and unverified/);
  });

  it('given_a_stale_validation_then_the_line_says_the_result_no_longer_applies', () => {
    const p = flowProvenance(flow({ signature: 'sig-2' }), {
      edges: EDGES,
      tests: [test()],
      results: [result()],
    });

    expect(describeProvenance(p).replay).toMatch(/no longer applies/i);
  });
});
