/**
 * API contract analysis with no OpenAPI spec.
 *
 * "API Contracts" used to refuse to run without an uploaded spec, so the traffic
 * captured during every run went unexamined. This checks the API against ITSELF.
 *
 * The distinction the report has to keep honest: inconsistency is a defect no spec
 * is needed to see; incorrectness is not knowable without one.
 */
import { describe, it, expect } from 'vitest';
import {
  analyzeObservedTraffic,
  formatObservedContractReport,
  normalizePath,
} from '../../../src/core/analysis/observed-contract';
import type { CapturedNetworkEntry } from '../../../src/storage/schemas';

const call = (over: Partial<CapturedNetworkEntry> = {}): CapturedNetworkEntry => ({
  url: 'https://app.test/api/users',
  method: 'GET',
  status: 200,
  statusText: 'OK',
  mimeType: 'application/json',
  duration: 120,
  bodySize: 512,
  ...over,
});

describe('grouping instances of a route', () => {
  it('given_ids_in_the_path_then_calls_to_the_same_route_merge', () => {
    // Otherwise every record id looks like its own endpoint and no pattern emerges.
    expect(normalizePath('https://app.test/api/users/42')).toBe('/api/users/:id');
    expect(normalizePath('https://app.test/api/users/8f14e45f-ea1a-4b2c-9d3e-1a2b3c4d5e6f/roles'))
      .toBe('/api/users/:uuid/roles');
    expect(normalizePath('https://app.test/api/docs/507f1f77bcf86cd799439011')).toBe('/api/docs/:objectId');
  });

  it('given_two_ids_of_the_same_route_then_one_endpoint_is_reported', () => {
    const r = analyzeObservedTraffic([
      call({ url: 'https://app.test/api/users/1' }),
      call({ url: 'https://app.test/api/users/2' }),
    ]);
    expect(r.endpoints).toHaveLength(1);
    expect(r.endpoints[0].calls).toBe(2);
    expect(r.endpoints[0].pathPattern).toBe('/api/users/:id');
  });

  it('given_a_real_word_segment_then_it_is_NOT_collapsed', () => {
    expect(normalizePath('https://app.test/api/settings/notifications')).toBe('/api/settings/notifications');
  });
});

describe('findings that need no spec', () => {
  it('given_a_500_then_it_is_high_severity', () => {
    const r = analyzeObservedTraffic([call({ status: 500 })]);
    expect(r.findings.some((f) => f.kind === 'server-error' && f.severity === 'high')).toBe(true);
  });

  it('given_the_same_call_succeeding_AND_failing_then_it_is_flagged_as_non_deterministic', () => {
    // The most valuable spec-free finding: the endpoint contradicts itself.
    const r = analyzeObservedTraffic([call({ status: 200 }), call({ status: 500 })]);
    const mixed = r.findings.find((f) => f.kind === 'mixed-status');
    expect(mixed).toBeDefined();
    expect(mixed?.severity).toBe('high');
  });

  it('given_two_content_types_from_one_endpoint_then_it_is_flagged', () => {
    // Usually an HTML error page served where JSON was promised.
    const r = analyzeObservedTraffic([
      call({ mimeType: 'application/json' }),
      call({ mimeType: 'text/html' }),
    ]);
    expect(r.findings.some((f) => f.kind === 'mixed-content-type')).toBe(true);
  });

  it('given_a_slow_endpoint_then_it_is_reported_with_its_median', () => {
    const r = analyzeObservedTraffic([call({ duration: 3000 }), call({ duration: 4000 })]);
    expect(r.findings.some((f) => f.kind === 'slow-endpoint')).toBe(true);
    expect(r.endpoints[0].medianMs).toBe(3500);
  });

  it('given_a_200_with_an_empty_body_then_it_is_flagged_but_DELETE_is_not', () => {
    expect(analyzeObservedTraffic([call({ bodySize: 0 })]).findings.some((f) => f.kind === 'empty-success')).toBe(true);
    expect(
      analyzeObservedTraffic([call({ bodySize: 0, method: 'DELETE' })]).findings.some((f) => f.kind === 'empty-success')
    ).toBe(false);
  });

  it('given_a_404_then_it_is_medium_not_high_because_it_may_be_correct', () => {
    // A negative test SHOULD produce a 404. Calling that an error would train people
    // to ignore the report.
    const r = analyzeObservedTraffic([call({ status: 404 })]);
    const f = r.findings.find((x) => x.kind === 'client-error');
    expect(f?.severity).toBe('medium');
  });

  it('given_clean_consistent_traffic_then_nothing_is_invented', () => {
    const r = analyzeObservedTraffic([call(), call(), call()]);
    expect(r.findings).toEqual([]);
    expect(r.endpoints[0].calls).toBe(3);
  });

  it('given_requests_with_no_status_then_they_are_counted_as_incomplete', () => {
    // Aborted or blocked requests must not be silently dropped from the totals.
    const r = analyzeObservedTraffic([call(), call({ status: 0 })]);
    expect(r.incomplete).toBe(1);
    expect(r.totalCalls).toBe(1);
  });
});

describe('the report states its own limits', () => {
  it('given_no_spec_then_the_report_says_it_compares_the_api_against_itself', () => {
    const md = formatObservedContractReport(analyzeObservedTraffic([call({ status: 500 })]));
    expect(md).toContain('against itself');
    expect(md).toContain('cannot show that an endpoint is wrong');
    expect(md).toContain('Upload a spec');
  });

  it('given_a_report_then_it_declares_that_schemas_are_out_of_reach', () => {
    // Bodies are not captured, so field-level checks are impossible — better said
    // than quietly missing.
    const md = formatObservedContractReport(analyzeObservedTraffic([call()]));
    expect(md).toContain('Response schemas');
    expect(md).toContain('not bodies');
  });

  it('given_endpoints_then_they_are_rendered_as_a_table', () => {
    const md = formatObservedContractReport(analyzeObservedTraffic([call()]));
    expect(md).toContain('| Method | Path | Calls | Statuses | Median | Slowest | Payload |');
    expect(md).toContain('| GET | `/api/users` |');
  });

  it('given_no_traffic_then_it_explains_how_to_capture_some', () => {
    const md = formatObservedContractReport(analyzeObservedTraffic([]));
    expect(md).toContain('No API traffic was captured');
    expect(md).toContain('debugger');
  });
});
