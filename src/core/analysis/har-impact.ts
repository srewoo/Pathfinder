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

const log = createLogger('har-impact');

// ── Types ──────────────────────────────────────────────────────────────────

export interface APIEndpointCoverage {
  /** Normalized endpoint (method + path without query params) */
  endpoint: string;
  method: string;
  /** How this endpoint was discovered */
  source: 'exploration' | 'test_execution' | 'both';
  /** Test IDs that exercised this endpoint */
  coveredByTests: string[];
  /** Test titles for display */
  coveredByTestTitles: string[];
  /** Page URLs where this endpoint was observed during exploration */
  explorationPages: string[];
  /** Context in which it was discovered (page load, form submit, etc.) */
  contexts: Set<string>;
  /** Whether any test has exercised this endpoint */
  isCovered: boolean;
}

export interface HARImpactReport {
  /** All discovered API endpoints with coverage status */
  endpoints: APIEndpointCoverage[];
  /** Summary statistics */
  summary: {
    totalEndpoints: number;
    coveredEndpoints: number;
    uncoveredEndpoints: number;
    coveragePercent: number;
  };
  /** Endpoints not exercised by any test — the coverage gaps */
  gaps: APIEndpointCoverage[];
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

// ── Main Analysis ──────────────────────────────────────────────────────────

/**
 * Build a complete API coverage report from exploration data + test results.
 */
export async function analyzeHARImpact(
  testResults: TestResult[],
  testRun?: TestRun
): Promise<HARImpactReport> {
  const graph = await loadGraph();
  const endpointMap = new Map<string, APIEndpointCoverage>();

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
        } else {
          endpointMap.set(key, {
            endpoint: key.split(' ')[1],
            method: api.method.toUpperCase(),
            source: 'exploration',
            coveredByTests: [],
            coveredByTestTitles: [],
            explorationPages: [node.url],
            contexts: new Set([api.context]),
            isCovered: false,
          });
        }
      }
    }
  }

  // 2. Map test results to endpoints via HAR entries
  const testEndpointMap = new Map<string, string[]>();
  const results = testRun?.results ?? testResults;

  for (const result of results) {
    if (!result.harEntries || result.harEntries.length === 0) continue;

    const testEndpoints: string[] = [];

    for (const entry of result.harEntries) {
      // Skip HTML document loads — we want API calls only
      if (entry.mimeType?.includes('text/html') && entry.method === 'GET') continue;

      const key = normalizeEndpoint(entry.url, entry.method);
      if (!key) continue;

      testEndpoints.push(key);

      const existing = endpointMap.get(key);
      if (existing) {
        if (!existing.coveredByTests.includes(result.testCaseId)) {
          existing.coveredByTests.push(result.testCaseId);
          existing.coveredByTestTitles.push(result.testCaseTitle);
        }
        existing.isCovered = true;
        if (existing.source === 'exploration') existing.source = 'both';
      } else {
        // Endpoint discovered only during test execution (not exploration)
        endpointMap.set(key, {
          endpoint: key.split(' ')[1],
          method: entry.method.toUpperCase(),
          source: 'test_execution',
          coveredByTests: [result.testCaseId],
          coveredByTestTitles: [result.testCaseTitle],
          explorationPages: [],
          contexts: new Set(['test_execution']),
          isCovered: true,
        });
      }
    }

    testEndpointMap.set(result.testCaseId, [...new Set(testEndpoints)]);
  }

  // 3. Build report
  const endpoints = [...endpointMap.values()];
  const gaps = endpoints.filter((e) => !e.isCovered);
  const covered = endpoints.filter((e) => e.isCovered);

  const report: HARImpactReport = {
    endpoints,
    summary: {
      totalEndpoints: endpoints.length,
      coveredEndpoints: covered.length,
      uncoveredEndpoints: gaps.length,
      coveragePercent: endpoints.length > 0
        ? Math.round((covered.length / endpoints.length) * 100)
        : 100,
    },
    gaps,
    testEndpointMap,
    generatedAt: new Date().toISOString(),
  };

  log.info(
    `HAR impact analysis: ${report.summary.coveredEndpoints}/${report.summary.totalEndpoints} endpoints covered (${report.summary.coveragePercent}%), ${gaps.length} gaps`
  );

  return report;
}

/**
 * Format the coverage report as a human-readable summary.
 */
export function formatHARImpactReport(report: HARImpactReport): string {
  const { coveredEndpoints, totalEndpoints, coveragePercent } = report.summary;
  const lines: string[] = ['# API Coverage', ''];

  if (totalEndpoints === 0) {
    lines.push('No API endpoints have been discovered yet.', '');
    lines.push(
      'Endpoints come from exploration (what the app calls) and are matched against ' +
        'traffic captured while tests run. Explore the app first, then run tests.'
    );
    return lines.join('\n');
  }

  lines.push(`**${coveredEndpoints} of ${totalEndpoints} endpoints exercised (${coveragePercent}%)**`, '');

  if (report.gaps.length > 0) {
    // Gaps first: the untested endpoints are the actionable half of this report.
    lines.push(`## Untested endpoints (${report.gaps.length})`, '');
    lines.push('| Method | Endpoint | Discovered on |');
    lines.push('|---|---|---|');
    for (const gap of report.gaps) {
      const pages = gap.explorationPages.slice(0, 2).map(shortenUrl).join(', ') ||
        '_unknown_';
      const more = gap.explorationPages.length > 2 ? ` +${gap.explorationPages.length - 2}` : '';
      lines.push(`| ${gap.method} | \`${gap.endpoint}\` | ${pages}${more} |`);
    }
    lines.push('');
  }

  const covered = report.endpoints.filter((e) => e.isCovered);
  if (covered.length > 0) {
    lines.push(`## Covered endpoints (${covered.length})`, '');
    lines.push('| Method | Endpoint | Exercised by |');
    lines.push('|---|---|---|');
    for (const ep of covered) {
      const tests = ep.coveredByTestTitles.slice(0, 2).join(', ') || '_a test_';
      const more = ep.coveredByTestTitles.length > 2 ? ` +${ep.coveredByTestTitles.length - 2}` : '';
      lines.push(`| ${ep.method} | \`${ep.endpoint}\` | ${tests}${more} |`);
    }
    lines.push('');
  }

  lines.push('## How this is measured', '');
  lines.push(
    '- The denominator is endpoints **exploration observed the app calling** — not every ' +
      'endpoint the API has. An endpoint no page ever calls cannot appear here.',
    '- The numerator is endpoints seen in traffic captured while tests ran, so a test ' +
      'that never reached its page contributes nothing.',
    '- 100% here means "every endpoint we know about was hit", not "every endpoint was ' +
      'verified" — see API Contracts for what the responses actually did.'
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
