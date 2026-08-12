/**
 * Schema findings and the verdict (ADR 001, phase 3).
 *
 * The property under test is the reason the whole feature exists: **a test can pass all
 * its assertions while the API it depends on breaks underneath it.** A removed field
 * often renders as an empty column, and every UI assertion still holds.
 *
 * So a breaking change becomes a high-severity finding, and the existing oracle verdict
 * path downgrades PASS → NEEDS_REVIEW. Never PASS → FAIL: a schema change is a prompt to
 * look, and a build break would get the signal switched off.
 */
import { describe, it, expect } from 'vitest';
import { inferSchema } from '../../../src/core/analysis/schema-infer';
import { buildBaseline } from '../../../src/core/analysis/api-baseline';
import {
  dominantOrigin,
  schemaFindingsForResult,
  withSchemaFindings,
} from '../../../src/core/analysis/schema-oracle';
import { verdictWithOracles } from '../../../src/core/report/result-adapter';
import type { CapturedNetworkEntry, TestResult } from '../../../src/storage/schemas';

const ORIGIN = 'https://app.test';

const entry = (over: Partial<CapturedNetworkEntry> = {}): CapturedNetworkEntry => ({
  url: `${ORIGIN}/api/users`,
  method: 'GET',
  status: 200,
  statusText: 'OK',
  mimeType: 'application/json',
  duration: 20,
  bodySize: 100,
  responseSchema: inferSchema({ id: 1, name: 'Ada' }),
  ...over,
});

const passing = (over: Partial<TestResult> = {}): TestResult =>
  ({
    id: 'r1',
    testCaseId: 't1',
    testCaseTitle: 'Employee list renders',
    status: 'passed',
    startedAt: '2026-08-12T10:00:00.000Z',
    duration: 300,
    steps: [{ step: { order: 0, action: 'click', description: 'Open list' }, status: 'passed', duration: 10 }],
    healingAttempts: [],
    runId: 'run-1',
    ...over,
  }) as TestResult;

const baselineOf = (schema: ReturnType<typeof inferSchema>) =>
  buildBaseline([entry({ responseSchema: schema })], { origin: ORIGIN, now: () => 0 });

describe('the headline property', () => {
  it('given_a_passing_test_whose_api_dropped_a_field_then_the_verdict_becomes_NEEDS_REVIEW', () => {
    const baseline = baselineOf(inferSchema({ id: 1, name: 'Ada' }));
    // This run: `name` is gone. The UI still rendered, so every assertion passed.
    const entries = [entry({ responseSchema: inferSchema({ id: 1 }) })];

    const findings = schemaFindingsForResult(entries, baseline, ORIGIN);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('high');
    expect(findings[0].kind).toBe('api-schema-breaking');

    const result = withSchemaFindings(passing(), findings);
    expect(result.status).toBe('passed');
    expect(verdictWithOracles(result)).toBe('NEEDS_REVIEW');
  });

  it('given_a_failing_test_then_a_schema_finding_does_not_soften_it', () => {
    const findings = schemaFindingsForResult(
      [entry({ responseSchema: inferSchema({ id: 1 }) })],
      baselineOf(inferSchema({ id: 1, name: 'Ada' })),
      ORIGIN
    );
    const failed = withSchemaFindings(passing({ status: 'failed' }), findings);
    expect(verdictWithOracles(failed)).toBe('FAIL');
  });

  it('given_the_finding_then_it_names_the_endpoint_and_the_change', () => {
    // A reader must be able to act on it without opening the baseline.
    const findings = schemaFindingsForResult(
      [entry({ responseSchema: inferSchema({ id: 1 }) })],
      baselineOf(inferSchema({ id: 1, name: 'Ada' })),
      ORIGIN
    );
    expect(findings[0].message).toContain('GET /api/users');
    expect(findings[0].evidence).toContain('name');
    expect(findings[0].message).toContain('assertions may still pass');
  });
});

describe('what must NOT produce a finding', () => {
  it('given_no_baseline_then_nothing_is_reported', () => {
    expect(schemaFindingsForResult([entry()], undefined, ORIGIN)).toEqual([]);
  });

  it('given_an_unchanged_api_then_nothing_is_reported', () => {
    const schema = inferSchema({ id: 1, name: 'Ada' });
    expect(schemaFindingsForResult([entry({ responseSchema: schema })], baselineOf(schema), ORIGIN)).toEqual([]);
  });

  it('given_only_ADDITIVE_changes_then_the_verdict_stands', () => {
    // A new optional field breaks nobody. Downgrading for it would make the signal
    // routine, and a routine warning is an ignored warning.
    const findings = schemaFindingsForResult(
      [entry({ responseSchema: inferSchema({ id: 1, name: 'Ada', nickname: 'A' }) })],
      baselineOf(inferSchema({ id: 1, name: 'Ada' })),
      ORIGIN
    );
    expect(findings).toEqual([]);
    expect(verdictWithOracles(withSchemaFindings(passing(), findings))).toBe('PASS');
  });

  it('given_an_endpoint_this_test_never_called_then_it_is_not_blamed_for_it', () => {
    // The baseline holds /api/orders; this test only touched /api/users. Reporting a
    // global "the API changed" would implicate every test for one endpoint.
    const baseline = buildBaseline(
      [
        entry(),
        entry({ url: `${ORIGIN}/api/orders`, responseSchema: inferSchema({ total: 10, currency: 'GBP' }) }),
      ],
      { origin: ORIGIN, now: () => 0 }
    );
    const findings = schemaFindingsForResult([entry()], baseline, ORIGIN);
    expect(findings).toEqual([]);
  });

  it('given_no_captured_schemas_then_nothing_is_reported', () => {
    // Non-JSON, oversized, non-2xx or off-allowlist traffic carries no schema, and
    // absence of evidence is not evidence of change.
    expect(
      schemaFindingsForResult([entry({ responseSchema: undefined })], baselineOf(inferSchema({ id: 1 })), ORIGIN)
    ).toEqual([]);
  });

  it('given_an_array_that_was_empty_at_baseline_then_gaining_data_does_not_downgrade', () => {
    const findings = schemaFindingsForResult(
      [entry({ responseSchema: inferSchema({ rows: [{ id: 1 }] }) })],
      baselineOf(inferSchema({ rows: [] })),
      ORIGIN
    );
    expect(findings).toEqual([]);
  });
});

describe('dominantOrigin', () => {
  it('given_mixed_traffic_then_the_app_origin_wins_over_third_parties', () => {
    const entries = [
      entry(),
      entry(),
      { url: 'https://cdn.other/analytics.js' } as CapturedNetworkEntry,
    ];
    expect(dominantOrigin(entries)).toBe(ORIGIN);
  });

  it('given_no_parseable_urls_then_it_is_undefined', () => {
    expect(dominantOrigin([{ url: 'not a url' } as CapturedNetworkEntry])).toBeUndefined();
    expect(dominantOrigin([])).toBeUndefined();
  });
});
