/**
 * T04 regression: API coverage must distinguish "a request happened" from
 * "something checked it", and must not invent a number when it knows nothing.
 *
 * Before this, an endpoint was `isCovered` the moment it appeared in captured
 * traffic — a page load that incidentally hit `GET /api/orders` counted exactly
 * the same as a test that asserted its response. And an empty inventory
 * reported 100%, so an app nobody had explored looked fully covered.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/core/explorer/interaction-graph', () => ({ loadGraph: vi.fn() }));

import { analyzeHARImpact, formatHARImpactReport } from '../../../src/core/analysis/har-impact';
import { loadGraph } from '../../../src/core/explorer/interaction-graph';
import type { TestResult, InteractionGraph, StepResult, ExecutionStep } from '../../../src/storage/schemas';
import type { ParsedAPISpec } from '../../../src/core/openapi/openapi-parser';

const mockedLoadGraph = vi.mocked(loadGraph);

/** An exploration graph that observed one endpoint on one page. */
function graphWith(endpoint: string, method = 'GET'): InteractionGraph {
  return {
    nodes: [
      {
        url: 'https://app.test/orders',
        title: 'Orders',
        elementCount: 3,
        apiEndpoints: [{ endpoint, method, status: 200, context: 'page_load' }],
      },
    ],
    edges: [],
    createdAt: '',
    updatedAt: '',
  } as unknown as InteractionGraph;
}

function harEntry(url: string, method = 'GET', status = 200) {
  return { url, method, status, mimeType: 'application/json' };
}

/** A passing network assertion step, as it is stored on a result. */
function assertionStep(
  assertType: ExecutionStep['assertType'],
  assertExpected: string,
  status: StepResult['status'] = 'passed'
): StepResult {
  return {
    step: { order: 2, action: 'assert', assertType, assertExpected, description: 'Check the API' },
    status,
    duration: 5,
  };
}

function result(over: Partial<TestResult> = {}): TestResult {
  return {
    id: 'tr-1',
    testCaseId: 'tc-1',
    testCaseTitle: 'Orders load',
    status: 'passed',
    startedAt: '2026-09-11T00:00:00.000Z',
    steps: [],
    healingAttempts: [],
    runId: 'run-1',
    harEntries: [],
    ...over,
  } as TestResult;
}

beforeEach(() => {
  mockedLoadGraph.mockReset();
  mockedLoadGraph.mockResolvedValue(undefined);
});

describe('an empty inventory', () => {
  // The headline lie. 100% of nothing is not full coverage.
  it('given_no_endpoints_then_coverage_is_absent_not_100_percent', async () => {
    const report = await analyzeHARImpact([]);

    expect(report.summary.totalEndpoints).toBe(0);
    expect(report.summary.exercisedPercent).toBeUndefined();
    expect(report.summary.verifiedPercent).toBeUndefined();
  });

  it('given_no_endpoints_then_the_report_says_no_data', async () => {
    const text = formatHARImpactReport(await analyzeHARImpact([]));

    expect(text).toMatch(/no data/i);
    expect(text).not.toContain('100%');
  });

  it('given_no_endpoints_then_the_empty_state_says_what_to_do', async () => {
    const text = formatHARImpactReport(await analyzeHARImpact([]));
    expect(text).toMatch(/explore|import/i);
  });
});

describe('exercised is not verified', () => {
  // The plan's first acceptance criterion.
  it('given_a_failed_test_that_called_an_endpoint_then_it_is_exercised_but_not_verified', async () => {
    mockedLoadGraph.mockResolvedValue(graphWith('https://app.test/api/orders'));
    const report = await analyzeHARImpact([
      result({ status: 'failed', harEntries: [harEntry('https://app.test/api/orders')] as never }),
    ]);

    const endpoint = report.endpoints[0];
    expect(endpoint.state).toBe('exercised');
    expect(endpoint.exercisedByTests).toEqual(['tc-1']);
    expect(endpoint.verifiedByTests).toEqual([]);
  });

  // Traffic alone is the old definition of covered, and it is not verification.
  it('given_a_passing_test_with_no_assertion_then_the_endpoint_is_only_exercised', async () => {
    mockedLoadGraph.mockResolvedValue(graphWith('https://app.test/api/orders'));
    const report = await analyzeHARImpact([
      result({ harEntries: [harEntry('https://app.test/api/orders')] as never }),
    ]);

    expect(report.endpoints[0].state).toBe('exercised');
    expect(report.summary.verified).toBe(0);
    expect(report.summary.exercised).toBe(1);
  });

  // An unrelated assertion in the same test proves nothing about this endpoint.
  it('given_an_unrelated_assertion_then_the_endpoint_is_not_verified', async () => {
    mockedLoadGraph.mockResolvedValue(graphWith('https://app.test/api/orders'));
    const report = await analyzeHARImpact([
      result({
        harEntries: [harEntry('https://app.test/api/orders')] as never,
        steps: [assertionStep('api_called', 'POST /api/checkout')],
      }),
    ]);

    expect(report.endpoints[0].state).toBe('exercised');
    expect(report.endpoints[0].verifiedByTests).toEqual([]);
  });

  // A UI assertion is not network evidence at all.
  it('given_a_passing_ui_assertion_then_the_endpoint_is_not_verified', async () => {
    mockedLoadGraph.mockResolvedValue(graphWith('https://app.test/api/orders'));
    const report = await analyzeHARImpact([
      result({
        harEntries: [harEntry('https://app.test/api/orders')] as never,
        steps: [
          {
            step: { order: 2, action: 'assert', assertType: 'visible', selector: '.list', description: 'List shows' },
            status: 'passed',
            duration: 3,
          },
        ],
      }),
    ]);

    expect(report.endpoints[0].state).toBe('exercised');
  });
});

describe('verification requires an attributable passing assertion', () => {
  it('given_a_passing_api_called_assertion_then_the_endpoint_is_verified', async () => {
    mockedLoadGraph.mockResolvedValue(graphWith('https://app.test/api/orders'));
    const report = await analyzeHARImpact([
      result({
        harEntries: [harEntry('https://app.test/api/orders')] as never,
        steps: [assertionStep('api_called', 'GET /api/orders')],
      }),
    ]);

    expect(report.endpoints[0].state).toBe('verified');
    expect(report.endpoints[0].verifiedByTests).toEqual(['tc-1']);
    expect(report.summary.verified).toBe(1);
  });

  it('given_a_passing_api_status_assertion_then_the_endpoint_is_verified', async () => {
    mockedLoadGraph.mockResolvedValue(graphWith('https://app.test/api/orders'));
    const report = await analyzeHARImpact([
      result({
        harEntries: [harEntry('https://app.test/api/orders')] as never,
        steps: [assertionStep('api_status', 'GET /api/orders 200')],
      }),
    ]);

    expect(report.endpoints[0].state).toBe('verified');
  });

  // A failed assertion is the opposite of evidence.
  it('given_a_failed_network_assertion_then_the_endpoint_is_not_verified', async () => {
    mockedLoadGraph.mockResolvedValue(graphWith('https://app.test/api/orders'));
    const report = await analyzeHARImpact([
      result({
        harEntries: [harEntry('https://app.test/api/orders')] as never,
        steps: [assertionStep('api_called', 'GET /api/orders', 'failed')],
      }),
    ]);

    expect(report.endpoints[0].state).toBe('exercised');
  });

  // `api_not_called` passing means the request did NOT happen — it verifies an
  // absence and says nothing about the endpoint.
  it('given_a_passing_api_not_called_assertion_then_nothing_is_verified_by_it', async () => {
    mockedLoadGraph.mockResolvedValue(graphWith('https://app.test/api/orders'));
    const report = await analyzeHARImpact([
      result({
        harEntries: [harEntry('https://app.test/api/orders')] as never,
        steps: [assertionStep('api_not_called', '/api/admin')],
      }),
    ]);

    expect(report.endpoints[0].state).toBe('exercised');
  });

  // Attribution goes through the raw entries, so a concrete id in the assertion
  // still resolves to the normalised key.
  it('given_an_assertion_naming_a_concrete_id_then_the_normalised_endpoint_is_verified', async () => {
    mockedLoadGraph.mockResolvedValue(undefined);
    const report = await analyzeHARImpact([
      result({
        harEntries: [harEntry('https://app.test/api/orders/12345')] as never,
        steps: [assertionStep('api_called', 'GET /api/orders/12345')],
      }),
    ]);

    expect(report.endpoints[0].endpoint).toContain(':id');
    expect(report.endpoints[0].state).toBe('verified');
  });

  it('given_a_method_mismatch_then_the_assertion_does_not_verify_the_endpoint', async () => {
    mockedLoadGraph.mockResolvedValue(undefined);
    const report = await analyzeHARImpact([
      result({
        harEntries: [harEntry('https://app.test/api/orders', 'GET')] as never,
        steps: [assertionStep('api_called', 'POST /api/orders')],
      }),
    ]);

    expect(report.endpoints[0].state).toBe('exercised');
  });
});

describe('the denominator states its source', () => {
  function spec(paths: Array<[string, string]>): ParsedAPISpec {
    return {
      title: 'API',
      version: '1',
      baseUrl: 'https://app.test',
      summary: '',
      endpoints: paths.map(([method, path]) => ({
        path,
        method,
        parameters: [],
        responses: [],
      })),
    } as ParsedAPISpec;
  }

  it('given_no_spec_then_the_source_is_observed_traffic', async () => {
    mockedLoadGraph.mockResolvedValue(graphWith('https://app.test/api/orders'));
    const report = await analyzeHARImpact([]);
    expect(report.summary.inventorySource).toBe('observed-traffic');
    expect(formatHARImpactReport(report)).toMatch(/observed in traffic/i);
  });

  it('given_a_spec_then_the_source_is_the_specification', async () => {
    const report = await analyzeHARImpact([], undefined, spec([['GET', '/api/orders']]));
    expect(report.summary.inventorySource).toBe('specification');
    expect(formatHARImpactReport(report)).toMatch(/imported OpenAPI spec/i);
  });

  // The whole point of a spec-backed denominator: it can show what is missing.
  it('given_a_specified_endpoint_nobody_called_then_it_is_a_gap', async () => {
    const report = await analyzeHARImpact(
      [],
      undefined,
      spec([['GET', '/api/orders'], ['POST', '/api/orders']])
    );

    expect(report.summary.totalEndpoints).toBe(2);
    expect(report.gaps).toHaveLength(2);
    expect(report.summary.unseenInSpec).toBe(2);
    expect(formatHARImpactReport(report)).toMatch(/spec only — never observed/i);
  });

  it('given_a_spec_path_parameter_then_it_matches_an_observed_concrete_id', async () => {
    const report = await analyzeHARImpact(
      [result({ harEntries: [harEntry('https://app.test/api/orders/99')] as never })],
      undefined,
      spec([['GET', '/api/orders/{orderId}']])
    );

    // One endpoint, not two — the spec template and the observed id are the
    // same endpoint.
    expect(report.summary.totalEndpoints).toBe(1);
    expect(report.endpoints[0].state).toBe('exercised');
  });

  // Two services are not one service because their paths agree.
  it('given_two_origins_with_the_same_path_then_they_stay_separate_endpoints', async () => {
    const report = await analyzeHARImpact([
      result({
        harEntries: [
          harEntry('https://app.test/api/orders'),
          harEntry('https://staging.test/api/orders'),
        ] as never,
      }),
    ]);

    expect(report.summary.totalEndpoints).toBe(2);
  });

  it('given_the_same_path_with_different_methods_then_they_are_separate_endpoints', async () => {
    const report = await analyzeHARImpact([
      result({
        harEntries: [
          harEntry('https://app.test/api/orders', 'GET'),
          harEntry('https://app.test/api/orders', 'POST'),
        ] as never,
      }),
    ]);

    expect(report.summary.totalEndpoints).toBe(2);
  });
});

describe('deprecated fields keep their old, weaker meaning', () => {
  // Legacy readers must get the traffic-only answer they always got, not a
  // missing field and not the stronger claim.
  it('given_an_exercised_endpoint_then_isCovered_is_true_and_state_is_exercised', async () => {
    mockedLoadGraph.mockResolvedValue(graphWith('https://app.test/api/orders'));
    const report = await analyzeHARImpact([
      result({ harEntries: [harEntry('https://app.test/api/orders')] as never }),
    ]);

    expect(report.endpoints[0].isCovered).toBe(true);
    expect(report.endpoints[0].state).toBe('exercised');
    expect(report.endpoints[0].coveredByTests).toEqual(['tc-1']);
  });

  it('given_an_endpoint_no_test_touched_then_isCovered_is_false', async () => {
    mockedLoadGraph.mockResolvedValue(graphWith('https://app.test/api/orders'));
    const report = await analyzeHARImpact([]);
    expect(report.endpoints[0].isCovered).toBe(false);
    expect(report.endpoints[0].state).toBe('observed');
  });

  it('given_an_empty_inventory_then_the_deprecated_percent_is_also_absent', async () => {
    const report = await analyzeHARImpact([]);
    expect(report.summary.coveragePercent).toBeUndefined();
  });
});

describe('the report separates the two kinds of gap', () => {
  it('given_a_mix_then_never_driven_and_never_checked_are_listed_apart', async () => {
    mockedLoadGraph.mockResolvedValue({
      nodes: [
        {
          url: 'https://app.test/orders',
          title: 'Orders',
          elementCount: 3,
          apiEndpoints: [
            { endpoint: 'https://app.test/api/orders', method: 'GET', status: 200, context: 'page_load' },
            { endpoint: 'https://app.test/api/untouched', method: 'GET', status: 200, context: 'page_load' },
          ],
        },
      ],
      edges: [],
      createdAt: '',
      updatedAt: '',
    } as unknown as InteractionGraph);

    const report = await analyzeHARImpact([
      result({ harEntries: [harEntry('https://app.test/api/orders')] as never }),
    ]);

    expect(report.gaps.map((g) => g.endpoint)).toEqual([expect.stringContaining('/api/untouched')]);
    expect(report.unverified.map((g) => g.endpoint)).toEqual([expect.stringContaining('/api/orders')]);

    const text = formatHARImpactReport(report);
    expect(text).toMatch(/Never driven by a test \(1\)/);
    expect(text).toMatch(/Called but never checked \(1\)/);
  });
});
