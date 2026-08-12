/**
 * Diff two inferred schemas and classify what changed (ADR 001, phase 2).
 *
 * The classification is the product. "Something changed" is noise; "a consumer of
 * this field now gets undefined" is a finding someone acts on. So every change is
 * labelled by its effect on a caller:
 *
 *   breaking      — existing readers break: a field vanished, changed type, or can
 *                   now be absent or null where it never was
 *   additive      — new surface, safe to ignore: a new optional field or enum value
 *   informational — we learned more, nothing changed: `unknown` became a real type
 *                   because an array that was empty last run has data this run
 *
 * That last class exists because of the most likely source of false alarms. An empty
 * array yields `array<unknown>`; when data arrives the element type resolves. Calling
 * that "type changed" would flag a break on every first-real-data run.
 */
import { describeSchema, isRequired, type InferredSchema, type SchemaField } from './schema-infer';

export type ChangeKind =
  | 'field-removed'
  | 'field-added'
  | 'type-changed'
  | 'became-nullable'
  | 'became-optional'
  | 'became-required'
  | 'enum-value-removed'
  | 'enum-value-added'
  | 'resolved-unknown'
  | 'truncated';

export type ChangeClass = 'breaking' | 'additive' | 'informational';

export interface SchemaChange {
  /** Dotted path, with `[]` for array elements: `data.items[].name`. */
  path: string;
  kind: ChangeKind;
  class: ChangeClass;
  detail: string;
}

const BREAKING: ReadonlySet<ChangeKind> = new Set<ChangeKind>([
  'field-removed',
  'type-changed',
  'became-nullable',
  'became-optional',
  'enum-value-removed',
]);

const classOf = (kind: ChangeKind): ChangeClass => {
  if (BREAKING.has(kind)) return 'breaking';
  if (kind === 'field-added' || kind === 'enum-value-added' || kind === 'became-required') return 'additive';
  return 'informational';
};

const change = (path: string, kind: ChangeKind, detail: string): SchemaChange => ({
  path: path || '(root)',
  kind,
  class: classOf(kind),
  detail,
});

export function diffSchemas(
  before: InferredSchema,
  after: InferredSchema,
  path = ''
): SchemaChange[] {
  const changes: SchemaChange[] = [];

  // An unresolved position learning its type is knowledge gained, not a break.
  if (before.kind === 'unknown' && after.kind !== 'unknown') {
    changes.push(
      change(path, 'resolved-unknown', `type is now ${describeSchema(after)} (was never observed before)`)
    );
    return changes;
  }
  // The reverse — a type we knew becoming unobserved — is a coverage gap, not a
  // contract change. Reporting it as breaking would blame the API for a thinner run.
  if (after.kind === 'unknown' && before.kind !== 'unknown') {
    changes.push(change(path, 'resolved-unknown', `no longer observed (was ${describeSchema(before)})`));
    return changes;
  }

  if (before.kind !== after.kind) {
    changes.push(
      change(path, 'type-changed', `${describeSchema(before)} → ${describeSchema(after)}`)
    );
    return changes; // no point descending into a different shape
  }

  if (!before.nullable && after.nullable) {
    changes.push(change(path, 'became-nullable', `can now be null (${describeSchema(after)})`));
  }

  if (before.kind === 'array') {
    changes.push(
      ...diffSchemas(
        before.items ?? { kind: 'unknown', samples: 0 },
        after.items ?? { kind: 'unknown', samples: 0 },
        `${path}[]`
      )
    );
    return changes;
  }

  if (before.kind === 'object') {
    const beforeFields = before.fields ?? {};
    const afterFields = after.fields ?? {};
    for (const key of Object.keys(beforeFields)) {
      const child = path ? `${path}.${key}` : key;
      const b = beforeFields[key];
      const a = afterFields[key];
      if (!a) {
        changes.push(
          change(child, 'field-removed', `was ${describeSchema(b.schema)}; a caller reading it now gets undefined`)
        );
        continue;
      }
      changes.push(...requiredness(child, b, a, before, after));
      changes.push(...diffSchemas(b.schema, a.schema, child));
    }
    for (const key of Object.keys(afterFields)) {
      if (beforeFields[key]) continue;
      const child = path ? `${path}.${key}` : key;
      const required = isRequired(afterFields[key], after.samples);
      changes.push(
        change(
          child,
          'field-added',
          `new ${required ? 'required' : 'optional'} field (${describeSchema(afterFields[key].schema)})`
        )
      );
    }
    return changes;
  }

  changes.push(...enums(path, before, after));
  return changes;
}

/**
 * Required → optional is breaking; the reverse is not.
 *
 * Suppressed when either side has too few samples to support the claim. Required-ness
 * from a single observation is an artefact of that observation, and flagging it would
 * make every short run look like a contract change.
 */
function requiredness(
  path: string,
  before: SchemaField,
  after: SchemaField,
  beforeParent: InferredSchema,
  afterParent: InferredSchema
): SchemaChange[] {
  const MIN_SAMPLES = 3;
  if (beforeParent.samples < MIN_SAMPLES || afterParent.samples < MIN_SAMPLES) return [];

  const was = isRequired(before, beforeParent.samples);
  const now = isRequired(after, afterParent.samples);
  if (was && !now) {
    return [
      change(
        path,
        'became-optional',
        `was present in all ${beforeParent.samples} sample(s), now in ${after.seen} of ${afterParent.samples}`
      ),
    ];
  }
  if (!was && now) {
    return [change(path, 'became-required', `now present in every sample (${afterParent.samples})`)];
  }
  return [];
}

function enums(path: string, before: InferredSchema, after: InferredSchema): SchemaChange[] {
  if (!before.enumValues || !after.enumValues) return [];
  const changes: SchemaChange[] = [];
  const removed = before.enumValues.filter((v) => !after.enumValues!.includes(v));
  const added = after.enumValues.filter((v) => !before.enumValues!.includes(v));
  if (removed.length > 0) {
    changes.push(
      change(path, 'enum-value-removed', `values no longer seen: ${removed.join(', ')} — a branch handling them may be unreachable`)
    );
  }
  if (added.length > 0) {
    changes.push(change(path, 'enum-value-added', `new values: ${added.join(', ')}`));
  }
  return changes;
}

export interface DiffSummary {
  breaking: number;
  additive: number;
  informational: number;
}

export function summarize(changes: readonly SchemaChange[]): DiffSummary {
  return {
    breaking: changes.filter((c) => c.class === 'breaking').length,
    additive: changes.filter((c) => c.class === 'additive').length,
    informational: changes.filter((c) => c.class === 'informational').length,
  };
}
