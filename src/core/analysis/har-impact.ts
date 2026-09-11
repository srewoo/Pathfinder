/**
 * Test Impact Analysis from HAR data.
 *
 * Maps which API endpoints each test exercises (from captured HAR entries),
 * then cross-references with all endpoints discovered during exploration
 * to surface untested API coverage gaps.
 */

import type {
  TestResult,
  TestRun,
} from '../../storage/schemas';
import { loadGraph } from '../explorer/interaction-graph';
import { createLogger } from '../../utils/logger';
import { parseNetworkSpec, networkEntryMatches } from '../executor/network-assertion';
import type { ParsedAPISpec } from '../openapi/openapi-parser';

const log = createLogger('har-impact');

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * How much is actually known about an endpoint.
 *
 * The distinction this type exists to make: a request happening is not the same
 * as a request being checked. Reporting them as one number — "covered" — meant a
 * page load that incidentally hit `GET /api/orders` counted the same as a test
 * that asserted its response, which is the difference between coverage and the
 * appearance of coverage.
 *
 *  observed  — seen in exploration traffic; no test has driven it
 *  exercised — a test's captured traffic hit it, pass or fail; nothing checked it
 *  verified  — a passing network assertion in that run was checking that request
 */
export type EndpointState = 'observed' | 'exercised' | 'verified';

/** Where the denominator comes from, so the percentage can be read honestly. */
export type InventorySource = 'observed-traffic' | 'specification';

export interface APIEndpointCoverage {
  /** Normalized endpoint (method + path without query params) */
  endpoint: string;
  method: string;
  /** How this endpoint was discovered */
  source: 'exploration' | 'test_execution' | 'both' | 'specification';
  /** Tests whose captured traffic hit this endpoint — whether they passed or not. */
  exercisedByTests: string[];
  exercisedByTestTitles: string[];
  /** Tests with a passing network assertion attributable to this endpoint. */
  verifiedByTests: string[];
  verifiedByTestTitles: string[];
  /** Page URLs where this endpoint was observed during exploration */
  explorationPages: string[];
  /** Context in which it was discovered (page load, form submit, etc.) */
  contexts: Set<string>;
  /** The strongest evidence available for this endpoint. */
  state: EndpointState;
  /**
   * @deprecated Traffic-only: true whenever a request happened, never "anything
   * checked it". It reads as verification and is not. Use `state`.
   */
  isCovered: boolean;
  /** @deprecated Alias of `exercisedByTests`. */
  coveredByTests: string[];
  /** @deprecated Alias of `exercisedByTestTitles`. */
  coveredByTestTitles: string[];
}

export interface HARImpactReport {
  /** All discovered API endpoints with coverage status */
  endpoints: APIEndpointCoverage[];
  /** Summary statistics */
  summary: {
    totalEndpoints: number;
    /** Discovered but never driven by a test. */
    observedOnly: number;
    /** Driven by a test's traffic — includes the verified ones. */
    exercised: number;
    /** Checked by a passing network assertion. */
    verified: number;
    /** Whether the denominator is discovered traffic or an imported spec. */
    inventorySource: InventorySource;
    /**
     * Percentages are absent, not zero and not 100, when there is nothing to
     * measure. An empty inventory used to report 100% coverage.
     */
    exercisedPercent?: number;
    verifiedPercent?: number;
    /** Endpoints in the spec that were never seen at all. Spec-backed only. */
    unseenInSpec?: number;
    /** @deprecated Traffic-only. Alias of `exercisedPercent`. */
    coveragePercent?: number;
    /** @deprecated Alias of `exercised`. */
    coveredEndpoints: number;
    /** @deprecated Alias of `observedOnly`. */
    uncoveredEndpoints: number;
  };
  /** Endpoints no test has driven — the coverage gaps */
  gaps: APIEndpointCoverage[];
  /** Exercised but never checked by an assertion — the weaker, larger gap. */
  unverified: APIEndpointCoverage[];
  /** Per-test breakdown: which endpoints each test hit */
  testEndpointMap: Map<string, string[]>;
  generatedAt: string;
}

// ── Normalization ──────────────────────────────────────────────────────────

const SKIP_PATTERNS = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map|webp|avif)(\?|$)/i;
const SKIP_PREFIXES = ['chrome-extension://', 'data:', 'blob:', 'about:'];

function normalizeEndpoint(url: string, method: string): string | null {
  if (SKIP_PATTERNS.test(url)) return null;
  if (SKIP_PREFIXES.some((p) => url.startsWith(p))) return null;

  try {
    const parsed = new URL(url);
    // Replace dynamic path segments with :param for grouping
    const normalizedPath = parsed.pathname
      .split('/')
      .map((seg) => {
        if (!seg) return seg;
        if (/^[0-9]+$/.test(seg)) return ':id';
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg)) return ':uuid';
        if (/^[0-9a-f]{20,}$/i.test(seg)) return ':hash';
        return seg;
      })
      .join('/');
    return `${method.toUpperCase()} ${parsed.origin}${normalizedPath}`;
  } catch {
    return `${method.toUpperCase()} ${url}`;
  }
}

/**
 * Endpoint keys a passing network assertion in this result was checking.
 *
 * Attribution works through the result's own captured traffic rather than by
 * string-matching the endpoint key, because keys are normalised (`/orders/123`
 * becomes `/orders/:id`) and an assertion naming a concrete id would never
 * match one. Matching the raw entries with the same predicate the assertion
 * used, then normalising those, is what makes the claim true rather than
 * plausible.
 *
 * `api_not_called` is excluded on purpose: it passing means the request did NOT
 * happen, which verifies an absence and tells you nothing about the endpoint.
 */
function verifiedKeysFor(result: TestResult): Set<string> {
  const verified = new Set<string>();
  const entries = result.harEntries ?? [];
  if (entries.length === 0) return verified;

  for (const stepResult of result.steps ?? []) {
    // Only a passing assertion is evidence. A failed one is the opposite.
    if (stepResult.status !== 'passed') continue;
    const step = stepResult.step;
    if (step.action !== 'assert') continue;
    if (step.assertType !== 'api_called' && step.assertType !== 'api_status') continue;

    const spec = parseNetworkSpec(step.assertExpected ?? '', step.assertType === 'api_status');
    if (!spec) continue;

    for (const entry of entries) {
      if (!networkEntryMatches(entry, spec)) continue;
      const key = normalizeEndpoint(entry.url, entry.method);
      if (key) verified.add(key);
    }
  }
  return verified;
}

/** The strongest evidence available, given who exercised and who verified. */
function stateOf(endpoint: APIEndpointCoverage): EndpointState {
  if (endpoint.verifiedByTests.length > 0) return 'verified';
  if (endpoint.exercisedByTests.length > 0) return 'exercised';
  return 'observed';
}

function blankEndpoint(
  key: string,
  method: string,
  source: APIEndpointCoverage['source'],
  contexts: string[]
): APIEndpointCoverage {
  return {
    endpoint: key.split(' ').slice(1).join(' '),
    method: method.toUpperCase(),
    source,
    exercisedByTests: [],
    exercisedByTestTitles: [],
    verifiedByTests: [],
    verifiedByTestTitles: [],
    explorationPages: [],
    contexts: new Set(contexts),
    state: 'observed',
    isCovered: false,
    coveredByTests: [],
    coveredByTestTitles: [],
  };
}

/**
 * Inventory from an imported OpenAPI spec.
 *
 * A spec-backed denominator is the only one that can show an endpoint that
 * exists and was never touched. The observed-traffic denominator structurally
 * cannot: an endpoint nobody called is simply absent from it, so coverage against
 * it always flatters.
 *
 * Origins are not merged — a spec's `baseUrl` and an observed request's origin
 * are the same service only if they are the same origin, and assuming otherwise
 * would silently mark a staging endpoint as covered by a production call.
 */
export function specInventory(spec: ParsedAPISpec): Map<string, APIEndpointCoverage> {
  const out = new Map<string, APIEndpointCoverage>();
  for (const endpoint of spec.endpoints) {
    // Spec paths carry their own parameter syntax (`{id}`); normalising through
    // the same function keeps spec and observed keys comparable.
    const url = joinSpecUrl(spec.baseUrl, endpoint.path);
    const key = normalizeEndpoint(url, endpoint.method);
    if (!key) continue;
    if (!out.has(key)) out.set(key, blankEndpoint(key, endpoint.method, 'specification', ['specification']));
  }
  return out;
}

function joinSpecUrl(baseUrl: string, path: string): string {
  // `{id}` → `:id` so a templated spec path and an observed numeric segment
  // normalise to the same key.
  const templated = path.replace(/\{[^}]+\}/g, ':id');
  if (!baseUrl) return templated;
  return `${baseUrl.replace(/\/+$/, '')}/${templated.replace(/^\/+/, '')}`;
}

// ── Main Analysis ──────────────────────────────────────────────────────────

/**
 * Build a complete API coverage report from exploration data + test results.
 */
export async function analyzeHARImpact(
  testResults: TestResult[],
  testRun?: TestRun,
  /** Imported spec. Supplying one changes the denominator to what should exist. */
  spec?: ParsedAPISpec
): Promise<HARImpactReport> {
  const graph = await loadGraph();
  // A spec seeds the inventory so endpoints that exist and were never called
  // still appear. Without one, the inventory can only contain what was seen.
  const endpointMap = spec ? specInventory(spec) : new Map<string, APIEndpointCoverage>();
  const inventorySource: InventorySource = spec ? 'specification' : 'observed-traffic';

  // 1. Collect all endpoints discovered during exploration
  if (graph) {
    for (const node of graph.nodes) {
      if (!node.apiEndpoints) continue;
      for (const api of node.apiEndpoints) {
        const key = normalizeEndpoint(api.endpoint, api.method);
        if (!key) continue;

        const existing = endpointMap.get(key);
        if (existing) {
          existing.explorationPages.push(node.url);
          existing.contexts.add(api.context);
          // A spec entry we have now actually seen is no longer spec-only.
          if (existing.source === 'specification') existing.source = 'exploration';
        } else {
          const created = blankEndpoint(key, api.method, 'exploration', [api.context]);
          created.explorationPages.push(node.url);
          endpointMap.set(key, created);
        }
      }
    }
  }

  // 2. Map test results to endpoints via HAR entries
  const testEndpointMap = new Map<string, string[]>();
  const results = testRun?.results ?? testResults;

  for (const result of results) {
    if (!result.harEntries || result.harEntries.length === 0) continue;

    // Which requests this test actually proved something about.
    const verified = verifiedKeysFor(result);
    const testEndpoints: string[] = [];

    for (const entry of result.harEntries) {
      // Skip HTML document loads — we want API calls only
      if (entry.mimeType?.includes('text/html') && entry.method === 'GET') continue;

      const key = normalizeEndpoint(entry.url, entry.method);
      if (!key) continue;

      testEndpoints.push(key);

      let endpoint = endpointMap.get(key);
      if (!endpoint) {
        // Seen during a test and nowhere else.
        endpoint = blankEndpoint(key, entry.method, 'test_execution', ['test_execution']);
        endpointMap.set(key, endpoint);
      } else if (endpoint.source === 'exploration' || endpoint.source === 'specification') {
        endpoint.source = endpoint.source === 'exploration' ? 'both' : 'test_execution';
      }

      // Exercised: a request happened during this test. Deliberately independent
      // of whether the test passed — a failing test still drove the endpoint,
      // and pretending otherwise would hide real traffic.
      if (!endpoint.exercisedByTests.includes(result.testCaseId)) {
        endpoint.exercisedByTests.push(result.testCaseId);
        endpoint.exercisedByTestTitles.push(result.testCaseTitle);
      }

      // Verified: a passing network assertion in this run was checking it.
      if (verified.has(key) && !endpoint.verifiedByTests.includes(result.testCaseId)) {
        endpoint.verifiedByTests.push(result.testCaseId);
        endpoint.verifiedByTestTitles.push(result.testCaseTitle);
      }
    }

    testEndpointMap.set(result.testCaseId, [...new Set(testEndpoints)]);
  }

  // 3. Build report
  const endpoints = [...endpointMap.values()];
  for (const endpoint of endpoints) {
    endpoint.state = stateOf(endpoint);
    // Deprecated mirrors, kept truthful rather than removed, so a legacy reader
    // gets the old (weaker) meaning rather than a missing field.
    endpoint.isCovered = endpoint.state !== 'observed';
    endpoint.coveredByTests = endpoint.exercisedByTests;
    endpoint.coveredByTestTitles = endpoint.exercisedByTestTitles;
  }

  const gaps = endpoints.filter((e) => e.state === 'observed');
  const unverified = endpoints.filter((e) => e.state === 'exercised');
  const exercised = endpoints.filter((e) => e.state !== 'observed');
  const verifiedEndpoints = endpoints.filter((e) => e.state === 'verified');

  // A share of nothing is not 100% — it is unknown. Reporting 100 for an empty
  // inventory told users their API was fully covered when nothing had been seen.
  const pct = (n: number) =>
    endpoints.length > 0 ? Math.round((n / endpoints.length) * 100) : undefined;
  const exercisedPercent = pct(exercised.length);

  const report: HARImpactReport = {
    endpoints,
    summary: {
      totalEndpoints: endpoints.length,
      observedOnly: gaps.length,
      exercised: exercised.length,
      verified: verifiedEndpoints.length,
      inventorySource,
      exercisedPercent,
      verifiedPercent: pct(verifiedEndpoints.length),
      unseenInSpec: spec
        ? endpoints.filter((e) => e.source === 'specification' && e.state === 'observed').length
        : undefined,
      coveragePercent: exercisedPercent,
      coveredEndpoints: exercised.length,
      uncoveredEndpoints: gaps.length,
    },
    gaps,
    unverified,
    testEndpointMap,
    generatedAt: new Date().toISOString(),
  };

  log.info(
    `API coverage (${inventorySource}): ${report.summary.totalEndpoints} endpoint(s) — ` +
      `${report.summary.verified} verified, ${report.summary.exercised} exercised, ` +
      `${report.summary.observedOnly} never driven by a test`
  );

  return report;
}

/**
 * Format the coverage report as a human-readable summary.
 */
export function formatHARImpactReport(report: HARImpactReport): string {
  const { totalEndpoints, verified, exercised, observedOnly, inventorySource } = report.summary;
  const lines: string[] = ['# API Coverage', ''];

  if (totalEndpoints === 0) {
    // Not "100% covered". There is nothing to have covered.
    lines.push('**No data** — no API endpoints are known yet, so there is no coverage to report.', '');
    lines.push(
      'Endpoints come from exploration (what the app calls) or from an imported OpenAPI ' +
        'spec, and are matched against traffic captured while tests run. Explore the app ' +
        'or import a spec first, then run tests.'
    );
    return lines.join('\n');
  }

  const denominator =
    inventorySource === 'specification'
      ? 'the imported OpenAPI spec'
      : 'endpoints observed in traffic';
  lines.push(`Denominator: **${denominator}** (${totalEndpoints} endpoint(s)).`, '');
  lines.push(
    `| State | Count | Means |`,
    `|---|---|---|`,
    `| Verified | ${verified} | A passing assertion checked this request |`,
    `| Exercised | ${exercised - verified} | A test called it; nothing checked it |`,
    `| Never driven | ${observedOnly} | No test has called it |`,
    ''
  );

  if (report.gaps.length > 0) {
    // The actionable half: endpoints no test touches at all.
    lines.push(`## Never driven by a test (${report.gaps.length})`, '');
    lines.push('| Method | Endpoint | Known from |');
    lines.push('|---|---|---|');
    for (const gap of report.gaps) {
      const from =
        gap.source === 'specification'
          ? '_spec only — never observed_'
          : gap.explorationPages.slice(0, 2).map(shortenUrl).join(', ') || '_unknown_';
      const more = gap.explorationPages.length > 2 ? ` +${gap.explorationPages.length - 2}` : '';
      lines.push(`| ${gap.method} | \`${gap.endpoint}\` | ${from}${more} |`);
    }
    lines.push('');
  }

  if (report.unverified.length > 0) {
    // The larger and more easily missed gap: traffic happened, nothing asserted.
    lines.push(`## Called but never checked (${report.unverified.length})`, '');
    lines.push('These ran during a test, but no assertion looked at the response.', '');
    lines.push('| Method | Endpoint | Exercised by |');
    lines.push('|---|---|---|');
    for (const ep of report.unverified) {
      const tests = ep.exercisedByTestTitles.slice(0, 2).join(', ') || '_a test_';
      const more = ep.exercisedByTestTitles.length > 2 ? ` +${ep.exercisedByTestTitles.length - 2}` : '';
      lines.push(`| ${ep.method} | \`${ep.endpoint}\` | ${tests}${more} |`);
    }
    lines.push('');
  }

  const verifiedEndpoints = report.endpoints.filter((e) => e.state === 'verified');
  if (verifiedEndpoints.length > 0) {
    lines.push(`## Verified endpoints (${verifiedEndpoints.length})`, '');
    lines.push('| Method | Endpoint | Verified by |');
    lines.push('|---|---|---|');
    for (const ep of verifiedEndpoints) {
      const tests = ep.verifiedByTestTitles.slice(0, 2).join(', ') || '_a test_';
      const more = ep.verifiedByTestTitles.length > 2 ? ` +${ep.verifiedByTestTitles.length - 2}` : '';
      lines.push(`| ${ep.method} | \`${ep.endpoint}\` | ${tests}${more} |`);
    }
    lines.push('');
  }

  lines.push('## How this is measured', '');
  lines.push(
    inventorySource === 'specification'
      ? '- The denominator is **every endpoint in the imported spec**, so an endpoint that ' +
          'exists and is never called shows up as a gap.'
      : '- The denominator is endpoints **observed in traffic** — not every endpoint the API ' +
          'has. An endpoint no page ever calls cannot appear here. Import an OpenAPI spec ' +
          'for a denominator that can show what is missing.',
    '- **Exercised** means a request happened while a test ran. It is recorded whether the ' +
      'test passed or failed — a failing test still drove the endpoint.',
    '- **Verified** means a passing `api_called` or `api_status` assertion in that run was ' +
      'checking that request. A successful HTTP response is not verification, and neither ' +
      'is an unrelated UI assertion in the same test.',
    '- Results stored before verification was tracked show as exercised, not verified — ' +
      'their assertion evidence is unknown rather than assumed.'
  );

  return lines.join('\n');
}


/** Keep a discovered-on URL short enough to read inside a panel table. */
function shortenUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 28 ? `…${u.pathname.slice(-27)}` : u.pathname;
    return path || '/';
  } catch {
    return url.length > 30 ? `…${url.slice(-29)}` : url;
  }
}
