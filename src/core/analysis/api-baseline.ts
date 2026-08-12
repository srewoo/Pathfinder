/**
 * API baselines: capture the shape of an API once, compare later runs against it
 * (ADR 001, phase 2).
 *
 * This is what makes contract checking useful without an OpenAPI spec. The first run
 * records what the API returned; every later run is diffed against that record, so a
 * field disappearing or changing type is a finding even though nobody wrote a spec.
 *
 * Endpoint identity is the subtle part. `/users/1` and `/users/2` are one endpoint, so
 * paths are normalised. GraphQL is worse: every operation shares one URL, so keying by
 * URL would merge unrelated shapes into one meaningless schema. Those are keyed by
 * `operationName`, taken from the request body we already capture.
 */
import type { CapturedNetworkEntry } from '../../storage/schemas';
import { mergeSchemas, type InferredSchema } from './schema-infer';
import { diffSchemas, summarize, type DiffSummary, type SchemaChange } from './schema-diff';
import { normalizePath } from './observed-contract';

export interface BaselineEndpoint {
  method: string;
  pathPattern: string;
  /** GraphQL operation name, when the endpoint is a GraphQL POST. */
  operation?: string;
  responseSchema: InferredSchema;
  statuses: number[];
  /** Responses whose schema contributed. Low counts weaken required-ness. */
  sampleCount: number;
}

export interface ApiBaseline {
  version: 1;
  origin: string;
  capturedAt: string;
  label?: string;
  endpoints: Record<string, BaselineEndpoint>;
}

export const BASELINE_VERSION = 1 as const;

/** Endpoint key: `METHOD /path` or `METHOD /graphql#operation`. */
export function endpointKey(entry: CapturedNetworkEntry): string {
  const path = normalizePath(entry.url);
  const method = entry.method.toUpperCase();
  const op = graphqlOperation(entry);
  return op ? `${method} ${path}#${op}` : `${method} ${path}`;
}

/**
 * GraphQL operation name, when this looks like a GraphQL call.
 *
 * Without this, a GraphQL app produces exactly one endpoint whose schema is the union
 * of every query it ever ran — a shape that matches nothing and diffs against nothing
 * usefully.
 */
export function graphqlOperation(entry: CapturedNetworkEntry): string | undefined {
  if (!/graphql/i.test(entry.url)) return undefined;
  const body = entry.requestBody;
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { operationName?: string; query?: string };
    if (parsed.operationName) return parsed.operationName;
    // Unnamed operation: take the first field of the selection set, which is stable
    // enough to separate one query from another.
    const m = /(?:query|mutation)\s*(?:\w+)?\s*(?:\([^)]*\))?\s*\{\s*(\w+)/.exec(parsed.query ?? '');
    return m ? `anonymous:${m[1]}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build a baseline from captured entries.
 *
 * Only entries that carry a schema contribute — an entry with no body captured (not
 * JSON, too large, non-2xx, off-allowlist) is counted as observed but adds no shape.
 */
export function buildBaseline(
  entries: readonly CapturedNetworkEntry[],
  meta: { origin: string; label?: string; now?: () => number }
): ApiBaseline {
  const now = meta.now ?? (() => Date.now());
  const endpoints: Record<string, BaselineEndpoint> = {};

  for (const entry of entries) {
    if (!entry.responseSchema) continue;
    const key = endpointKey(entry);
    const existing = endpoints[key];
    if (existing) {
      existing.responseSchema = mergeSchemas(existing.responseSchema, entry.responseSchema);
      existing.sampleCount++;
      if (!existing.statuses.includes(entry.status)) existing.statuses.push(entry.status);
    } else {
      endpoints[key] = {
        method: entry.method.toUpperCase(),
        pathPattern: normalizePath(entry.url),
        operation: graphqlOperation(entry),
        responseSchema: entry.responseSchema,
        statuses: [entry.status],
        sampleCount: 1,
      };
    }
  }

  return {
    version: BASELINE_VERSION,
    origin: meta.origin,
    capturedAt: new Date(now()).toISOString(),
    label: meta.label,
    endpoints,
  };
}

export interface EndpointDiff {
  key: string;
  /** Present in the baseline but not in this run — coverage OR removal, unknowable. */
  notObserved?: boolean;
  /** Present in this run but not in the baseline. */
  isNew?: boolean;
  changes: SchemaChange[];
}

export interface BaselineDiff {
  baselineCapturedAt: string;
  endpoints: EndpointDiff[];
  summary: DiffSummary & { endpointsCompared: number; notObserved: number; newEndpoints: number };
}

export function diffAgainstBaseline(baseline: ApiBaseline, current: ApiBaseline): BaselineDiff {
  const endpoints: EndpointDiff[] = [];
  const keys = new Set([...Object.keys(baseline.endpoints), ...Object.keys(current.endpoints)]);

  for (const key of [...keys].sort()) {
    const before = baseline.endpoints[key];
    const after = current.endpoints[key];

    if (before && !after) {
      // Deliberately NOT called "removed". A test that stopped reaching an endpoint
      // produces exactly this, and blaming the API for a thinner run would be wrong.
      endpoints.push({ key, notObserved: true, changes: [] });
      continue;
    }
    if (!before && after) {
      endpoints.push({ key, isNew: true, changes: [] });
      continue;
    }
    if (!before || !after) continue;

    const changes = diffSchemas(before.responseSchema, after.responseSchema);
    if (changes.length > 0) endpoints.push({ key, changes });
  }

  const allChanges = endpoints.flatMap((e) => e.changes);
  return {
    baselineCapturedAt: baseline.capturedAt,
    endpoints,
    summary: {
      ...summarize(allChanges),
      endpointsCompared: [...keys].filter((k) => baseline.endpoints[k] && current.endpoints[k]).length,
      notObserved: endpoints.filter((e) => e.notObserved).length,
      newEndpoints: endpoints.filter((e) => e.isNew).length,
    },
  };
}

/** Endpoint keys whose schema changed in a way that breaks existing callers. */
export function breakingEndpoints(diff: BaselineDiff): string[] {
  return diff.endpoints
    .filter((e) => e.changes.some((c) => c.class === 'breaking'))
    .map((e) => e.key);
}

export function formatBaselineDiff(diff: BaselineDiff): string {
  const s = diff.summary;
  const lines: string[] = ['# API schema changes since the baseline', ''];
  lines.push(
    `Baseline captured ${new Date(diff.baselineCapturedAt).toLocaleString()} — ` +
      `${s.endpointsCompared} endpoint(s) compared.`
  );
  lines.push('');
  lines.push('| Breaking | Additive | Informational | Not observed | New |');
  lines.push('|---:|---:|---:|---:|---:|');
  lines.push(`| ${s.breaking} | ${s.additive} | ${s.informational} | ${s.notObserved} | ${s.newEndpoints} |`);
  lines.push('');

  if (s.breaking === 0 && s.additive === 0 && s.informational === 0 && s.notObserved === 0 && s.newEndpoints === 0) {
    lines.push('No schema changes. Every endpoint returned the shape the baseline recorded.', '');
    return lines.join('\n');
  }

  const withChanges = diff.endpoints.filter((e) => e.changes.length > 0);
  if (withChanges.length > 0) {
    lines.push('## Changes', '');
    lines.push('| Class | Endpoint | Path | Change |');
    lines.push('|---|---|---|---|');
    const rank = { breaking: 0, additive: 1, informational: 2 } as const;
    const rows = withChanges
      .flatMap((e) => e.changes.map((c) => ({ key: e.key, c })))
      .sort((a, b) => rank[a.c.class] - rank[b.c.class]);
    for (const { key, c } of rows) {
      const badge = c.class === 'breaking' ? '**BREAKING**' : c.class;
      lines.push(`| ${badge} | \`${key}\` | \`${c.path}\` | ${c.detail.replace(/\|/g, '\\|')} |`);
    }
    lines.push('');
  }

  const missing = diff.endpoints.filter((e) => e.notObserved);
  if (missing.length > 0) {
    lines.push('## In the baseline, not seen this run', '');
    lines.push(
      '_Either the endpoint is gone, or this run never reached it. The difference is not ' +
        'visible from traffic, so it is not guessed at._',
      ''
    );
    for (const e of missing) lines.push(`- \`${e.key}\``);
    lines.push('');
  }

  const added = diff.endpoints.filter((e) => e.isNew);
  if (added.length > 0) {
    lines.push('## New since the baseline', '');
    for (const e of added) lines.push(`- \`${e.key}\``);
    lines.push('');
  }

  lines.push('## How to read this', '');
  lines.push(
    '- **Breaking** means an existing caller changes behaviour: a field vanished, changed ' +
      'type, or can now be absent or null where it never was.',
    '- **Informational** is usually an array that was empty when the baseline was taken ' +
      'and has data now — knowledge gained, not a change.',
    '- Required-ness needs at least 3 samples on both sides before it is reported at all.',
    '- Only JSON responses under 256KB from allowlisted origins contribute a schema.'
  );
  return lines.join('\n');
}
