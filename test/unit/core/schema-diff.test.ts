/**
 * Schema diffing and baselines (ADR 001, phase 2).
 *
 * The classification is the product: "something changed" is noise, "a caller of this
 * field now gets undefined" is a finding. So most of these tests are about which class
 * a change lands in — and especially about the two things that must NOT be called
 * breaking, because either would make the feature cry wolf until it was ignored.
 */
import { describe, it, expect } from 'vitest';
import { inferSchema, mergeSchemas } from '../../../src/core/analysis/schema-infer';
import { diffSchemas, summarize } from '../../../src/core/analysis/schema-diff';
import {
  buildBaseline,
  breakingEndpoints,
  diffAgainstBaseline,
  endpointKey,
  formatBaselineDiff,
  graphqlOperation,
} from '../../../src/core/analysis/api-baseline';
import type { CapturedNetworkEntry } from '../../../src/storage/schemas';

/** Merge N identical samples so required-ness has enough support to be reported. */
const samples = (value: unknown, n: number) => {
  let s = inferSchema(value);
  for (let i = 1; i < n; i++) s = mergeSchemas(s, inferSchema(value));
  return s;
};

describe('breaking changes', () => {
  it('given_a_removed_field_then_it_is_breaking', () => {
    const changes = diffSchemas(inferSchema({ id: 1, name: 'a' }), inferSchema({ id: 1 }));
    const c = changes.find((x) => x.kind === 'field-removed');
    expect(c?.class).toBe('breaking');
    expect(c?.path).toBe('name');
    expect(c?.detail).toContain('undefined');
  });

  it('given_a_changed_type_then_it_is_breaking', () => {
    const changes = diffSchemas(inferSchema({ id: 1 }), inferSchema({ id: '1' }));
    expect(changes[0].kind).toBe('type-changed');
    expect(changes[0].class).toBe('breaking');
    expect(changes[0].detail).toBe('number → string');
  });

  it('given_a_field_that_becomes_nullable_then_it_is_breaking', () => {
    const before = inferSchema({ name: 'a' });
    const after = mergeSchemas(inferSchema({ name: 'a' }), inferSchema({ name: null }));
    const c = diffSchemas(before, after).find((x) => x.kind === 'became-nullable');
    expect(c?.class).toBe('breaking');
  });

  it('given_a_required_field_that_becomes_optional_then_it_is_breaking', () => {
    const before = samples({ id: 1, note: 'x' }, 4);
    const after = mergeSchemas(samples({ id: 1, note: 'x' }, 3), inferSchema({ id: 2 }));
    const c = diffSchemas(before, after).find((x) => x.kind === 'became-optional');
    expect(c?.class).toBe('breaking');
    expect(c?.path).toBe('note');
  });

  it('given_an_enum_value_that_disappears_then_it_is_breaking', () => {
    const before = mergeSchemas(inferSchema({ s: 'a' }), inferSchema({ s: 'b' }));
    const after = samples({ s: 'a' }, 2);
    const c = diffSchemas(before, after).find((x) => x.kind === 'enum-value-removed');
    expect(c?.class).toBe('breaking');
    expect(c?.detail).toContain('unreachable');
  });

  it('given_a_nested_field_then_the_path_locates_it', () => {
    const before = inferSchema({ data: { items: [{ id: 1, label: 'x' }] } });
    const after = inferSchema({ data: { items: [{ id: 1 }] } });
    const c = diffSchemas(before, after).find((x) => x.kind === 'field-removed');
    expect(c?.path).toBe('data.items[].label');
  });
});

describe('what must NOT be called breaking', () => {
  it('given_an_array_that_was_empty_at_baseline_then_gaining_data_is_INFORMATIONAL', () => {
    // The likeliest false alarm in the whole feature: `array<unknown>` resolving to
    // `array<object>` on the first run with data.
    const before = inferSchema({ rows: [] });
    const after = inferSchema({ rows: [{ id: 1 }] });
    const changes = diffSchemas(before, after);
    expect(changes.every((c) => c.class !== 'breaking')).toBe(true);
    expect(changes[0].kind).toBe('resolved-unknown');
  });

  it('given_a_position_that_stops_being_observed_then_it_is_informational_not_breaking', () => {
    // A thinner run is a coverage gap, not an API change.
    const changes = diffSchemas(inferSchema({ rows: [{ id: 1 }] }), inferSchema({ rows: [] }));
    expect(changes.every((c) => c.class !== 'breaking')).toBe(true);
  });

  it('given_a_new_optional_field_then_it_is_additive', () => {
    const changes = diffSchemas(inferSchema({ id: 1 }), inferSchema({ id: 1, extra: true }));
    expect(changes[0].kind).toBe('field-added');
    expect(changes[0].class).toBe('additive');
  });

  it('given_a_new_enum_value_then_it_is_additive', () => {
    const before = samples({ s: 'a' }, 2);
    const after = mergeSchemas(inferSchema({ s: 'a' }), inferSchema({ s: 'b' }));
    const c = diffSchemas(before, after).find((x) => x.kind === 'enum-value-added');
    expect(c?.class).toBe('additive');
  });

  it('given_fewer_than_three_samples_then_requiredness_is_not_reported_at_all', () => {
    // Required-ness from one observation is an artefact of that observation. Reporting
    // it would make every short run look like a contract change.
    const before = inferSchema({ id: 1, note: 'x' });
    const after = inferSchema({ id: 1 });
    const changes = diffSchemas(before, after);
    expect(changes.some((c) => c.kind === 'became-optional')).toBe(false);
  });

  it('given_identical_schemas_then_nothing_is_reported', () => {
    expect(diffSchemas(inferSchema({ a: 1, b: 'x' }), inferSchema({ a: 1, b: 'x' }))).toEqual([]);
  });
});

const entry = (over: Partial<CapturedNetworkEntry> = {}): CapturedNetworkEntry => ({
  url: 'https://app.test/api/users',
  method: 'GET',
  status: 200,
  statusText: 'OK',
  mimeType: 'application/json',
  duration: 20,
  bodySize: 100,
  responseSchema: inferSchema({ id: 1, name: 'Ada' }),
  ...over,
});

describe('endpoint identity', () => {
  it('given_record_ids_in_the_path_then_calls_share_one_key', () => {
    expect(endpointKey(entry({ url: 'https://app.test/api/users/7' }))).toBe('GET /api/users/:id');
  });

  it('given_graphql_then_operations_are_kept_apart', () => {
    // Without this, every query on /graphql merges into one schema that matches nothing.
    const listUsers = entry({
      url: 'https://app.test/graphql',
      method: 'POST',
      requestBody: JSON.stringify({ operationName: 'ListUsers', query: 'query ListUsers { users { id } }' }),
    });
    const getOrder = entry({
      url: 'https://app.test/graphql',
      method: 'POST',
      requestBody: JSON.stringify({ operationName: 'GetOrder', query: 'query GetOrder { order { id } }' }),
    });
    expect(endpointKey(listUsers)).toBe('POST /graphql#ListUsers');
    expect(endpointKey(getOrder)).toBe('POST /graphql#GetOrder');
  });

  it('given_an_anonymous_graphql_query_then_the_root_field_names_it', () => {
    const anon = entry({
      url: 'https://app.test/graphql',
      method: 'POST',
      requestBody: JSON.stringify({ query: '{ viewer { id } }' }),
    });
    // Falls back rather than merging everything unnamed together.
    expect(graphqlOperation(anon)).toBeUndefined();
    const named = entry({
      url: 'https://app.test/graphql',
      method: 'POST',
      requestBody: JSON.stringify({ query: 'query { viewer { id } }' }),
    });
    expect(graphqlOperation(named)).toBe('anonymous:viewer');
  });

  it('given_a_non_graphql_url_then_no_operation_is_inferred', () => {
    expect(graphqlOperation(entry())).toBeUndefined();
  });
});

describe('baselines', () => {
  const origin = 'https://app.test';

  it('given_entries_then_repeat_calls_merge_and_raise_the_sample_count', () => {
    const b = buildBaseline([entry(), entry(), entry()], { origin, now: () => 0 });
    expect(Object.keys(b.endpoints)).toEqual(['GET /api/users']);
    expect(b.endpoints['GET /api/users'].sampleCount).toBe(3);
  });

  it('given_entries_with_no_schema_then_they_contribute_no_shape', () => {
    // Non-JSON, oversized, non-2xx and off-allowlist responses arrive without a schema.
    const b = buildBaseline([entry({ responseSchema: undefined })], { origin, now: () => 0 });
    expect(Object.keys(b.endpoints)).toHaveLength(0);
  });

  it('given_a_field_removed_since_the_baseline_then_the_endpoint_is_reported_breaking', () => {
    const before = buildBaseline([entry()], { origin, now: () => 0 });
    const after = buildBaseline([entry({ responseSchema: inferSchema({ id: 1 }) })], { origin, now: () => 1 });
    const diff = diffAgainstBaseline(before, after);
    expect(diff.summary.breaking).toBe(1);
    expect(breakingEndpoints(diff)).toEqual(['GET /api/users']);
  });

  it('given_an_endpoint_absent_from_the_run_then_it_is_NOT_called_removed', () => {
    // A test that stopped reaching an endpoint looks identical to a deleted endpoint.
    // Guessing between them would put words in the API's mouth.
    const before = buildBaseline([entry()], { origin, now: () => 0 });
    const after = buildBaseline([], { origin, now: () => 1 });
    const diff = diffAgainstBaseline(before, after);
    expect(diff.summary.notObserved).toBe(1);
    expect(diff.summary.breaking).toBe(0);
    const md = formatBaselineDiff(diff);
    expect(md).toContain('not seen this run');
    expect(md).toContain('Either the endpoint is gone, or this run never reached it');
  });

  it('given_a_new_endpoint_then_it_is_reported_separately_from_changes', () => {
    const before = buildBaseline([], { origin, now: () => 0 });
    const after = buildBaseline([entry()], { origin, now: () => 1 });
    const diff = diffAgainstBaseline(before, after);
    expect(diff.summary.newEndpoints).toBe(1);
    expect(diff.summary.breaking).toBe(0);
  });

  it('given_no_changes_then_the_report_says_so_plainly', () => {
    const b = buildBaseline([entry()], { origin, now: () => 0 });
    const md = formatBaselineDiff(diffAgainstBaseline(b, b));
    expect(md).toContain('No schema changes');
  });

  it('given_changes_then_the_report_is_a_table_with_breaking_first', () => {
    const before = buildBaseline([entry()], { origin, now: () => 0 });
    const after = buildBaseline(
      [entry({ responseSchema: inferSchema({ id: 1, extra: true }) }),
       entry({ url: 'https://app.test/api/orders', responseSchema: inferSchema({ total: 'now-a-string' }) })],
      { origin, now: () => 1 }
    );
    const md = formatBaselineDiff(diffAgainstBaseline(before, after));
    expect(md).toContain('| Class | Endpoint | Path | Change |');
    expect(md).toContain('How to read this');
    expect(md).toContain('at least 3 samples');
  });
});

describe('summarize', () => {
  it('given_mixed_changes_then_each_class_is_counted', () => {
    const changes = diffSchemas(
      inferSchema({ keep: 1, drop: 'x' }),
      inferSchema({ keep: 1, added: true })
    );
    const s = summarize(changes);
    expect(s.breaking).toBe(1);
    expect(s.additive).toBe(1);
  });
});
