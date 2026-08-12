/**
 * What the captured traffic says about the API, with no OpenAPI spec.
 *
 * "API Contracts" refused to run without an uploaded spec, which meant the traffic
 * already captured during every run went unexamined. This derives what it honestly
 * can from that traffic alone.
 *
 * The boundary matters, so it is stated in the report rather than implied: with no
 * spec there is no *intended* contract to compare against, so nothing here can tell
 * you an endpoint is wrong. What it CAN tell you is where an endpoint is
 * inconsistent with itself — the same call returning 200 and 500, or JSON and HTML —
 * which is a defect regardless of what any spec says.
 *
 * Response schemas are out of reach: `CapturedNetworkEntry` records status, type,
 * size and duration, not bodies. Field-level checks would need body capture, which
 * is a storage and privacy decision, not an oversight to paper over here.
 */
import type { CapturedNetworkEntry } from '../../storage/schemas';

export interface ObservedEndpoint {
  method: string;
  /** Path with numeric/UUID segments collapsed, so `/users/1` and `/users/2` merge. */
  pathPattern: string;
  calls: number;
  statuses: Record<number, number>;
  mimeTypes: string[];
  medianMs: number;
  slowestMs: number;
  totalBytes: number;
}

export type ObservedFindingKind =
  | 'server-error'
  | 'client-error'
  | 'mixed-status'
  | 'mixed-content-type'
  | 'slow-endpoint'
  | 'empty-success';

export interface ObservedFinding {
  kind: ObservedFindingKind;
  endpoint: string;
  message: string;
  severity: 'high' | 'medium' | 'low';
}

export interface ObservedContractReport {
  endpoints: ObservedEndpoint[];
  findings: ObservedFinding[];
  totalCalls: number;
  /** Requests that never got a status — aborted, blocked, or still in flight. */
  incomplete: number;
}

/** Threshold above which an endpoint is called out as slow. */
const SLOW_MS = 2000;

/** Collapse identifier-looking path segments so instances of a route merge. */
export function normalizePath(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.split('?')[0];
  }
  return (
    path
      .split('/')
      .map((seg) => {
        if (/^\d+$/.test(seg)) return ':id';
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ':uuid';
        if (/^[0-9a-f]{24}$/i.test(seg)) return ':objectId';
        // Long opaque tokens: mixed case/digits and no vowels to speak of.
        if (seg.length > 20 && /\d/.test(seg) && /[a-z]/i.test(seg)) return ':token';
        return seg;
      })
      .join('/') || '/'
  );
}

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
};

export function analyzeObservedTraffic(entries: readonly CapturedNetworkEntry[]): ObservedContractReport {
  const groups = new Map<string, { entry: CapturedNetworkEntry; durations: number[] }[]>();
  let incomplete = 0;

  for (const e of entries) {
    if (!e.status || e.status === 0) { incomplete++; continue; }
    const key = `${e.method.toUpperCase()} ${normalizePath(e.url)}`;
    const bucket = groups.get(key) ?? [];
    bucket.push({ entry: e, durations: [] });
    groups.set(key, bucket);
  }

  const endpoints: ObservedEndpoint[] = [];
  const findings: ObservedFinding[] = [];

  for (const [key, bucket] of [...groups.entries()].sort()) {
    const [method, ...rest] = key.split(' ');
    const pathPattern = rest.join(' ');
    const statuses: Record<number, number> = {};
    const mimeTypes = new Set<string>();
    const durations: number[] = [];
    let totalBytes = 0;

    for (const { entry } of bucket) {
      statuses[entry.status] = (statuses[entry.status] ?? 0) + 1;
      if (entry.mimeType) mimeTypes.add(entry.mimeType.split(';')[0].trim());
      durations.push(entry.duration || 0);
      totalBytes += entry.bodySize || 0;
    }

    const observed: ObservedEndpoint = {
      method,
      pathPattern,
      calls: bucket.length,
      statuses,
      mimeTypes: [...mimeTypes],
      medianMs: median(durations),
      slowestMs: Math.max(...durations, 0),
      totalBytes,
    };
    endpoints.push(observed);

    const codes = Object.keys(statuses).map(Number);
    const server = codes.filter((c) => c >= 500);
    const client = codes.filter((c) => c >= 400 && c < 500);
    const success = codes.filter((c) => c >= 200 && c < 300);

    for (const code of server) {
      findings.push({
        kind: 'server-error',
        endpoint: key,
        severity: 'high',
        message: `returned ${code} ${statuses[code]} time(s) — a server error is a defect no spec can excuse.`,
      });
    }
    for (const code of client) {
      findings.push({
        kind: 'client-error',
        endpoint: key,
        severity: code === 404 || code === 401 || code === 403 ? 'medium' : 'low',
        message:
          `returned ${code} ${statuses[code]} time(s). Expected for a negative test; ` +
          `otherwise the test is sending something the API rejects.`,
      });
    }
    if (success.length > 0 && (server.length > 0 || client.length > 0)) {
      findings.push({
        kind: 'mixed-status',
        endpoint: key,
        severity: 'high',
        message:
          `the same call both succeeded and failed (${codes.sort().join(', ')}) — ` +
          `non-deterministic behaviour, or state-dependent in a way the tests do not control.`,
      });
    }
    if (observed.mimeTypes.length > 1) {
      findings.push({
        kind: 'mixed-content-type',
        endpoint: key,
        severity: 'medium',
        message: `answered with more than one content type (${observed.mimeTypes.join(', ')}).`,
      });
    }
    if (observed.medianMs > SLOW_MS) {
      findings.push({
        kind: 'slow-endpoint',
        endpoint: key,
        severity: 'low',
        message: `median response ${observed.medianMs}ms (slowest ${observed.slowestMs}ms).`,
      });
    }
    if (success.length > 0 && observed.totalBytes === 0 && method !== 'DELETE' && method !== 'HEAD') {
      findings.push({
        kind: 'empty-success',
        endpoint: key,
        severity: 'medium',
        message: `succeeded with an empty body every time — the caller may be reading nothing.`,
      });
    }
  }

  return {
    endpoints: endpoints.sort((a, b) => b.calls - a.calls),
    findings: findings.sort((a, b) => severityRank(b.severity) - severityRank(a.severity)),
    totalCalls: entries.length - incomplete,
    incomplete,
  };
}

const severityRank = (s: ObservedFinding['severity']): number =>
  s === 'high' ? 3 : s === 'medium' ? 2 : 1;

const bytes = (n: number): string =>
  n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;

const statusCell = (statuses: Record<number, number>): string =>
  Object.entries(statuses)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([code, n]) => (n > 1 ? `${code}×${n}` : code))
    .join(', ');

export function formatObservedContractReport(report: ObservedContractReport): string {
  const lines: string[] = ['# API Contracts — from captured traffic', ''];

  if (report.endpoints.length === 0) {
    lines.push('No API traffic was captured.', '');
    lines.push(
      'Traffic is recorded through CDP while tests run. Run a test with the debugger ' +
        'attached, then re-run this analysis.'
    );
    return lines.join('\n');
  }

  lines.push(
    `**${report.endpoints.length} endpoint(s)** across **${report.totalCalls} call(s)**.` +
      (report.incomplete > 0 ? ` ${report.incomplete} request(s) never completed.` : '')
  );
  lines.push('');
  lines.push(
    '> No OpenAPI spec is loaded, so this compares the API **against itself**, not ' +
      'against an intended contract. It can show that an endpoint is inconsistent; it ' +
      'cannot show that an endpoint is wrong. Upload a spec in Settings for field- and ' +
      'type-level validation.'
  );
  lines.push('');

  if (report.findings.length > 0) {
    lines.push('## Findings', '');
    lines.push('| Severity | Endpoint | Observation |');
    lines.push('|---|---|---|');
    for (const f of report.findings) {
      const badge = f.severity === 'high' ? '**HIGH**' : f.severity === 'medium' ? 'MEDIUM' : 'low';
      lines.push(`| ${badge} | \`${f.endpoint}\` | ${f.message} |`);
    }
    lines.push('');
  } else {
    lines.push('## Findings', '', 'Nothing inconsistent found in the captured traffic.', '');
  }

  lines.push('## Endpoints observed', '');
  lines.push('| Method | Path | Calls | Statuses | Median | Slowest | Payload |');
  lines.push('|---|---|---:|---|---:|---:|---:|');
  for (const e of report.endpoints) {
    lines.push(
      `| ${e.method} | \`${e.pathPattern}\` | ${e.calls} | ${statusCell(e.statuses)} | ` +
        `${e.medianMs}ms | ${e.slowestMs}ms | ${bytes(e.totalBytes)} |`
    );
  }
  lines.push('');

  lines.push('## What this cannot check', '');
  lines.push(
    '- **Response schemas** — field names, types, required-ness. Captured entries hold ' +
      'status, content type, size and timing, not bodies.',
    '- **Whether a status is correct** — only whether it is consistent. A 404 may be the ' +
      'right answer.',
    '- **Endpoints never called.** Only traffic the tests actually produced appears here; ' +
      'see API Coverage for the gap against the endpoints exploration discovered.'
  );

  return lines.join('\n');
}
