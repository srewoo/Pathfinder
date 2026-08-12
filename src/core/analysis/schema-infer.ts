/**
 * Infer a structural schema from JSON response bodies (ADR 001, phase 1).
 *
 * The whole feature rests on this being the thing we persist instead of the body.
 * A schema for a 400KB employee list is a few hundred bytes, contains no salaries or
 * email addresses, and — unlike the body — only changes when the contract changes.
 * Two bodies differ on every run through ids and timestamps; two schemas differ when
 * something actually broke.
 *
 * Required-ness is the reason samples are counted rather than merged away: a field is
 * required only if it appeared in EVERY sample, and that claim is worthless from one
 * observation. The count travels with the schema so a report can say "inferred from 1
 * sample" instead of asserting something it cannot know.
 */

export type SchemaKind =
  | 'unknown'   // nothing observed yet — an empty array's element type
  | 'null'      // only ever null
  | 'string'
  | 'number'
  | 'boolean'
  | 'array'
  | 'object'
  | 'mixed';    // conflicting types across samples, which is itself a finding

export interface SchemaField {
  schema: InferredSchema;
  /** How many samples contained this key. Required ⇔ seen === parent.samples. */
  seen: number;
}

export interface InferredSchema {
  kind: SchemaKind;
  /** True when `null` was observed for this position in at least one sample. */
  nullable?: boolean;
  /** Element schema for arrays. */
  items?: InferredSchema;
  /** Field schemas for objects. */
  fields?: Record<string, SchemaField>;
  /** Distinct primitive values, while there are few enough to be meaningful. */
  enumValues?: Array<string | number | boolean>;
  /** How many samples contributed to this schema. Only meaningful at the root/object. */
  samples: number;
  /** Set when a depth or key cap stopped inference short of the real shape. */
  truncated?: boolean;
}

export interface InferOptions {
  /** Nesting levels to descend. Beyond this the position becomes `unknown`. */
  maxDepth?: number;
  /** Keys to record per object. */
  maxKeys?: number;
  /** Distinct values above which a set stops being an enum. */
  maxEnumValues?: number;
}

const DEFAULTS = { maxDepth: 6, maxKeys: 200, maxEnumValues: 8 } as const;

/** A field is required when every sample of its parent contained it. */
export function isRequired(field: SchemaField, parentSamples: number): boolean {
  return parentSamples > 0 && field.seen >= parentSamples;
}

export function inferSchema(value: unknown, options: InferOptions = {}): InferredSchema {
  const opts = { ...DEFAULTS, ...options };
  return infer(value, 0, opts);
}

function infer(value: unknown, depth: number, opts: Required<InferOptions>): InferredSchema {
  if (depth > opts.maxDepth) return { kind: 'unknown', samples: 1, truncated: true };
  if (value === null) return { kind: 'null', samples: 1, nullable: true };

  if (Array.isArray(value)) {
    // An empty array teaches nothing about its elements. Recording `unknown` rather
    // than guessing is what stops the first run WITH data from looking like a
    // breaking change.
    let items: InferredSchema = { kind: 'unknown', samples: 0 };
    for (const el of value.slice(0, 50)) {
      items = mergeSchemas(items, infer(el, depth + 1, opts));
    }
    return { kind: 'array', items, samples: 1 };
  }

  if (typeof value === 'object') {
    const fields: Record<string, SchemaField> = {};
    const keys = Object.keys(value as Record<string, unknown>);
    const truncated = keys.length > opts.maxKeys;
    for (const key of keys.slice(0, opts.maxKeys)) {
      fields[key] = { schema: infer((value as Record<string, unknown>)[key], depth + 1, opts), seen: 1 };
    }
    return { kind: 'object', fields, samples: 1, truncated: truncated || undefined };
  }

  const kind: SchemaKind =
    typeof value === 'string' ? 'string' : typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'unknown';
  const schema: InferredSchema = { kind, samples: 1 };
  if (kind !== 'unknown') schema.enumValues = [value as string | number | boolean];
  return schema;
}

/**
 * Combine two schemas for the same position.
 *
 * `unknown` is absorbing in the useful direction: `unknown + object = object`. That
 * single rule is what makes an empty array in one run compatible with a populated one
 * in the next, instead of a false "type changed" every time data appears.
 */
export function mergeSchemas(a: InferredSchema, b: InferredSchema, options: InferOptions = {}): InferredSchema {
  const opts = { ...DEFAULTS, ...options };
  if (a.kind === 'unknown' && a.samples === 0) return b;
  if (b.kind === 'unknown' && b.samples === 0) return a;

  const samples = a.samples + b.samples;

  // `null` narrows nothing — it only records that the position can be null.
  if (a.kind === 'null' && b.kind !== 'null') return { ...b, samples, nullable: true };
  if (b.kind === 'null' && a.kind !== 'null') return { ...a, samples, nullable: true };

  if (a.kind !== b.kind) {
    return { kind: 'mixed', samples, nullable: a.nullable || b.nullable };
  }

  const nullable = a.nullable || b.nullable || undefined;
  const truncated = a.truncated || b.truncated || undefined;

  if (a.kind === 'array') {
    return {
      kind: 'array',
      samples,
      nullable,
      truncated,
      items: mergeSchemas(a.items ?? { kind: 'unknown', samples: 0 }, b.items ?? { kind: 'unknown', samples: 0 }, opts),
    };
  }

  if (a.kind === 'object') {
    const fields: Record<string, SchemaField> = {};
    const keys = new Set([...Object.keys(a.fields ?? {}), ...Object.keys(b.fields ?? {})]);
    for (const key of keys) {
      const fa = a.fields?.[key];
      const fb = b.fields?.[key];
      if (fa && fb) {
        fields[key] = { schema: mergeSchemas(fa.schema, fb.schema, opts), seen: fa.seen + fb.seen };
      } else {
        // Present in only one side: carried over, and its `seen` stays behind the
        // parent's sample count, which is exactly what makes it optional.
        fields[key] = (fa ?? fb) as SchemaField;
      }
    }
    return { kind: 'object', fields, samples, nullable, truncated };
  }

  // Primitives: keep the value set while it is small enough to mean something.
  const merged: InferredSchema = { kind: a.kind, samples, nullable, truncated };
  if (a.enumValues && b.enumValues) {
    const union = [...new Set([...a.enumValues, ...b.enumValues])];
    if (union.length <= opts.maxEnumValues) merged.enumValues = union.sort(compareValues);
  }
  return merged;
}

function compareValues(x: string | number | boolean, y: string | number | boolean): number {
  return String(x).localeCompare(String(y));
}

/** Parse a JSON body and infer its schema. Returns null for anything unparseable. */
export function inferSchemaFromJson(body: string, options: InferOptions = {}): InferredSchema | null {
  try {
    return inferSchema(JSON.parse(body), options);
  } catch {
    return null;
  }
}

/** One-line description of a schema position, for reports. */
export function describeSchema(schema: InferredSchema): string {
  const base = (() => {
    switch (schema.kind) {
      case 'array': return `array<${schema.items ? describeSchema(schema.items) : 'unknown'}>`;
      case 'object': return `object{${Object.keys(schema.fields ?? {}).length} field(s)}`;
      case 'mixed': return 'mixed';
      default: return schema.kind;
    }
  })();
  return schema.nullable && schema.kind !== 'null' ? `${base}?` : base;
}
