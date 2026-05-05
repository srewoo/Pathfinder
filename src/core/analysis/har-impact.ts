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
  const lines: string[] = [
    `## API Coverage Report`,
    ``,
    `**Coverage:** ${report.summary.coveredEndpoints}/${report.summary.totalEndpoints} endpoints (${report.summary.coveragePercent}%)`,
    ``,
  ];

  if (report.gaps.length > 0) {
    lines.push(`### Untested Endpoints (${report.gaps.length})`, ``);
    for (const gap of report.gaps) {
      const pages = gap.explorationPages.slice(0, 2).join(', ');
      lines.push(`- \`${gap.method} ${gap.endpoint}\` — discovered on: ${pages}`);
    }
    lines.push(``);
  }

  if (report.endpoints.some((e) => e.isCovered)) {
    lines.push(`### Covered Endpoints`, ``);
    for (const ep of report.endpoints.filter((e) => e.isCovered)) {
      const tests = ep.coveredByTestTitles.slice(0, 3).join(', ');
      lines.push(`- \`${ep.method} ${ep.endpoint}\` — tested by: ${tests}`);
    }
  }

  return lines.join('\n');
}
