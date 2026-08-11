import { describe, it, expect } from 'vitest';
import {
  MAX_SCREENSHOTS,
  TRACE_SCHEMA,
  buildRunTrace,
  formatTraceSummary,
  prioritizeScreenshots,
  serializeTrace,
  type BuildTraceInput,
} from '../../../src/core/report/run-trace';
import { buildTestabilityReport } from '../../../src/core/report/heal-ledger';
import { fromCss } from '../../../src/core/locator';
import type { ExportRun } from '../../../src/core/report/junit-export';

const emptySummary = {
  mutationsPermitted: 0,
  requestsRefused: 0,
  refusedByOrigin: 0,
  refusedByMethod: 0,
  changedEndpoints: [],
};

function run(overrides: Partial<ExportRun> = {}): ExportRun {
  return {
    runId: 'r1',
    suiteName: 'Suite',
    startedAt: '2026-08-11T10:00:00.000Z',
    durationMs: 4200,
    results: [
      {
        id: 't1',
        name: 'Passes',
        verdict: 'PASS',
        durationMs: 100,
        startedAt: '2026-08-11T10:00:00.000Z',
        healedLocatorCount: 0,
        steps: [],
      },
    ],
    ...overrides,
  };
}

function input(overrides: Partial<BuildTraceInput> = {}): BuildTraceInput {
  return {
    runId: 'r1',
    createdAt: '2026-08-11T10:00:05.000Z',
    run: run(),
    heals: [],
    mutationSummary: emptySummary,
    mutationEntries: [],
    testability: buildTestabilityReport([]),
    network: [],
    ...overrides,
  };
}

describe('buildRunTrace', () => {
  it('given_a_run_then_the_trace_carries_a_schema_id', () => {
    expect(buildRunTrace(input()).schema).toBe(TRACE_SCHEMA);
  });

  it('given_irs_then_they_are_embedded_so_a_failure_can_be_reproduced', () => {
    const trace = buildRunTrace(
      input({
        irs: [
          {
            irVersion: '1',
            id: 't1',
            name: 'Passes',
            provenance: {
              source: 'user',
              promptVersion: 'n/a',
              model: 'n/a',
              generatedAt: 1,
              deterministic: false,
            },
            steps: [],
            assertions: [
              { order: 0, kind: 'url', expected: '/x', description: 'url', confidence: 'inferred' },
            ],
            tags: [],
          },
        ],
      })
    );
    expect(trace.tests.t1).toBeDefined();
  });

  it('given_a_trace_then_it_serializes_to_valid_json', () => {
    expect(() => JSON.parse(serializeTrace(buildRunTrace(input())))).not.toThrow();
  });
});

describe('prioritizeScreenshots', () => {
  it('given_fewer_screenshots_than_the_cap_then_all_are_kept_untouched', () => {
    const shots = { 't1:0': 'a', 't1:1': 'b' };
    expect(prioritizeScreenshots(shots, new Set())).toEqual(shots);
  });

  it('given_more_screenshots_than_the_cap_then_failures_are_kept_first', () => {
    // A screenshot of a passing step is rarely what anyone opens.
    const shots: Record<string, string> = {};
    for (let i = 0; i < 30; i++) shots[`pass:${i}`] = 'p';
    for (let i = 0; i < 5; i++) shots[`fail:${i}`] = 'f';

    const kept = prioritizeScreenshots(shots, new Set(['fail']), 10);
    for (let i = 0; i < 5; i++) expect(kept[`fail:${i}`]).toBe('f');
  });

  it('given_truncation_then_it_is_disclosed_rather_than_silent', () => {
    // A silent cap is the reporting equivalent of a silent catch.
    const shots: Record<string, string> = {};
    for (let i = 0; i < 40; i++) shots[`t:${i}`] = 'x';
    const kept = prioritizeScreenshots(shots, new Set(), MAX_SCREENSHOTS);
    expect(kept.__truncated).toMatch(/omitted/);
  });
});

describe('formatTraceSummary', () => {
  it('given_a_clean_run_then_it_states_that_nothing_was_changed', () => {
    // The reassurance a user actually wants after a read-only crawl.
    expect(formatTraceSummary(buildRunTrace(input()))).toContain('No remote state was changed');
  });

  it('given_permitted_mutations_then_the_changed_endpoints_are_listed_prominently', () => {
    const text = formatTraceSummary(
      buildRunTrace(
        input({
          mutationSummary: {
            ...emptySummary,
            mutationsPermitted: 2,
            changedEndpoints: ['POST https://app.test/orders', 'DELETE https://app.test/x'],
          },
        })
      )
    );
    expect(text).toContain('CHANGED remote state');
    expect(text).toContain('POST https://app.test/orders');
  });

  it('given_refusals_then_they_are_reported_so_a_quiet_run_is_not_mistaken_for_a_clean_one', () => {
    // "Found nothing" vs "was blocked 40 times" is the difference between a
    // clean bill of health and a misconfiguration.
    const text = formatTraceSummary(
      buildRunTrace(
        input({
          mutationSummary: {
            ...emptySummary,
            requestsRefused: 40,
            refusedByOrigin: 38,
            refusedByMethod: 2,
          },
        })
      )
    );
    expect(text).toContain('40 request(s) refused');
    expect(text).toContain('38 off-allowlist');
  });

  it('given_heals_then_they_are_listed_with_their_tier_transition', () => {
    const text = formatTraceSummary(
      buildRunTrace(
        input({
          heals: [
            {
              at: 1,
              testId: 't1',
              stepOrder: 2,
              locatorKey: 'k',
              target: '#save',
              from: 'testid',
              to: 'structural',
            },
          ],
        })
      )
    );
    expect(text).toContain('#save: testid → structural');
  });

  it('given_many_heals_then_the_list_discloses_the_remainder', () => {
    const heals = Array.from({ length: 15 }, (_, i) => ({
      at: i,
      testId: 't1',
      stepOrder: i,
      locatorKey: `k${i}`,
      target: `#e${i}`,
      from: 'testid' as const,
      to: 'structural' as const,
    }));
    expect(formatTraceSummary(buildRunTrace(input({ heals })))).toMatch(/and 5 more/);
  });

  it('given_testability_gaps_then_the_summary_recommends_test_ids', () => {
    const text = formatTraceSummary(
      buildRunTrace(
        input({ testability: buildTestabilityReport([{ locator: fromCss('.x') }]) })
      )
    );
    expect(text).toContain('data-testid');
  });
});
