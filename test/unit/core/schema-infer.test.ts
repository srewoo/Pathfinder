/**
 * Schema inference (ADR 001, phase 1).
 *
 * This is what gets persisted INSTEAD of the response body, so its properties are the
 * feature's properties: it must hold no payload values it doesn't need, survive being
 * merged across samples, and never assert required-ness it cannot support.
 */
import { describe, it, expect } from 'vitest';
import {
  describeSchema,
  inferSchema,
  inferSchemaFromJson,
  isRequired,
  mergeSchemas,
} from '../../../src/core/analysis/schema-infer';

describe('inferring one sample', () => {
  it('given_an_object_then_field_types_are_recorded', () => {
    const s = inferSchema({ id: 1, name: 'Ada', active: true, manager: null });
    expect(s.kind).toBe('object');
    expect(s.fields?.id.schema.kind).toBe('number');
    expect(s.fields?.name.schema.kind).toBe('string');
    expect(s.fields?.active.schema.kind).toBe('boolean');
    expect(s.fields?.manager.schema.kind).toBe('null');
  });

  it('given_nested_structures_then_they_are_described_to_depth', () => {
    const s = inferSchema({ data: { items: [{ name: 'x' }] } });
    const items = s.fields?.data.schema.fields?.items.schema;
    expect(items?.kind).toBe('array');
    expect(items?.items?.kind).toBe('object');
    expect(items?.items?.fields?.name.schema.kind).toBe('string');
  });

  it('given_an_EMPTY_array_then_the_element_type_is_unknown_not_guessed', () => {
    // The single most important case. Guessing here makes the first run WITH data look
    // like a breaking change.
    const s = inferSchema({ rows: [] });
    expect(s.fields?.rows.schema.kind).toBe('array');
    expect(s.fields?.rows.schema.items?.kind).toBe('unknown');
  });

  it('given_deep_nesting_beyond_the_cap_then_it_is_marked_truncated', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 12; i++) deep = { next: deep };
    const s = inferSchema(deep, { maxDepth: 3 });
    expect(JSON.stringify(s)).toContain('"truncated":true');
  });

  it('given_more_keys_than_the_cap_then_the_object_is_marked_truncated', () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 30; i++) wide[`k${i}`] = i;
    const s = inferSchema(wide, { maxKeys: 10 });
    expect(Object.keys(s.fields ?? {})).toHaveLength(10);
    expect(s.truncated).toBe(true);
  });

  it('given_malformed_json_then_nothing_is_inferred', () => {
    expect(inferSchemaFromJson('not json at all')).toBeNull();
    expect(inferSchemaFromJson('')).toBeNull();
  });

  it('given_a_body_then_no_VALUES_of_free_text_survive_beyond_small_enums', () => {
    // The privacy property: a schema must not become a copy of the payload. Long or
    // varied strings are dropped once they exceed the enum threshold.
    const samples = Array.from({ length: 20 }, (_, i) => ({ email: `user${i}@corp.test` }));
    let merged = inferSchema(samples[0]);
    for (const s of samples.slice(1)) merged = mergeSchemas(merged, inferSchema(s));
    expect(merged.fields?.email.schema.enumValues).toBeUndefined();
    expect(JSON.stringify(merged)).not.toContain('user7@corp.test');
  });
});

describe('merging across samples', () => {
  it('given_unknown_then_a_real_type_wins', () => {
    // array<unknown> from an empty list must accept array<object> later without
    // reporting a conflict.
    const empty = inferSchema({ rows: [] });
    const full = inferSchema({ rows: [{ id: 1 }] });
    const merged = mergeSchemas(empty, full);
    expect(merged.fields?.rows.schema.items?.kind).toBe('object');
  });

  it('given_null_in_one_sample_then_the_field_becomes_nullable_not_mixed', () => {
    const merged = mergeSchemas(inferSchema({ manager: null }), inferSchema({ manager: 'Ada' }));
    expect(merged.fields?.manager.schema.kind).toBe('string');
    expect(merged.fields?.manager.schema.nullable).toBe(true);
  });

  it('given_genuinely_conflicting_types_then_the_result_is_mixed', () => {
    const merged = mergeSchemas(inferSchema({ id: 1 }), inferSchema({ id: 'one' }));
    expect(merged.fields?.id.schema.kind).toBe('mixed');
  });

  it('given_a_field_in_every_sample_then_it_is_required', () => {
    let s = inferSchema({ id: 1, note: 'x' });
    s = mergeSchemas(s, inferSchema({ id: 2, note: 'y' }));
    s = mergeSchemas(s, inferSchema({ id: 3, note: 'z' }));
    expect(s.samples).toBe(3);
    expect(isRequired(s.fields!.id, s.samples)).toBe(true);
  });

  it('given_a_field_missing_from_one_sample_then_it_is_optional', () => {
    let s = inferSchema({ id: 1, note: 'x' });
    s = mergeSchemas(s, inferSchema({ id: 2 }));
    expect(isRequired(s.fields!.id, s.samples)).toBe(true);
    expect(isRequired(s.fields!.note, s.samples)).toBe(false);
  });

  it('given_a_small_value_set_then_it_is_kept_as_an_enum', () => {
    let s = inferSchema({ status: 'active' });
    s = mergeSchemas(s, inferSchema({ status: 'archived' }));
    expect(s.fields?.status.schema.enumValues).toEqual(['active', 'archived']);
  });

  it('given_too_many_distinct_values_then_the_enum_is_dropped', () => {
    let s = inferSchema({ status: 'v0' });
    for (let i = 1; i < 12; i++) s = mergeSchemas(s, inferSchema({ status: `v${i}` }));
    expect(s.fields?.status.schema.enumValues).toBeUndefined();
  });

  it('given_merges_in_either_order_then_the_result_is_the_same_shape', () => {
    const a = inferSchema({ id: 1, extra: true });
    const b = inferSchema({ id: 2 });
    const ab = mergeSchemas(a, b);
    const ba = mergeSchemas(b, a);
    expect(ab.samples).toBe(ba.samples);
    expect(Object.keys(ab.fields ?? {}).sort()).toEqual(Object.keys(ba.fields ?? {}).sort());
    expect(isRequired(ab.fields!.extra, ab.samples)).toBe(isRequired(ba.fields!.extra, ba.samples));
  });
});

describe('describeSchema', () => {
  it('given_shapes_then_they_read_clearly_in_a_report', () => {
    expect(describeSchema(inferSchema('x'))).toBe('string');
    expect(describeSchema(inferSchema([{ a: 1 }]))).toBe('array<object{1 field(s)}>');
    expect(describeSchema(inferSchema([]))).toBe('array<unknown>');
    const nullable = mergeSchemas(inferSchema('x'), inferSchema(null));
    expect(describeSchema(nullable)).toBe('string?');
  });
});
