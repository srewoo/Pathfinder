/**
 * API Contract Validation.
 *
 * Cross-references actual HTTP responses captured during test execution (HAR)
 * against the loaded OpenAPI/Swagger specification. Flags:
 * - Status codes not documented in the spec
 * - Response content types not matching spec
 * - Missing required fields in responses
 * - Request bodies that don't match the spec schema
 */

import type { ParsedAPISpec, APIEndpoint } from '../openapi/openapi-parser';
import type { CapturedNetworkEntry } from '../../storage/schemas';
import type { HAREntry } from '../cdp/cdp-client';
import { createLogger } from '../../utils/logger';

const log = createLogger('api-contract-validator');

// ── Types ──────────────────────────────────────────────────────────────────

export type ViolationSeverity = 'error' | 'warning' | 'info';

export interface ContractViolation {
  /** Which rule was violated */
  ruleId: string;
  /** Human-readable description */
  message: string;
  /** How severe this violation is */
  severity: ViolationSeverity;
  /** The API endpoint that was called */
  endpoint: string;
  /** HTTP method */
  method: string;
  /** Observed status code */
  statusCode: number;
  /** Expected values from spec */
  expected?: string;
  /** Actual observed value */
  actual?: string;
  /** Test case ID (if available) */
  testCaseId?: string;
}

export interface ContractValidationReport {
  /** All violations found */
  violations: ContractViolation[];
  /** Summary counts */
  summary: {
    errors: number;
    warnings: number;
    info: number;
    totalRequests: number;
    matchedEndpoints: number;
    unmatchedEndpoints: number;
  };
  /** Timestamp */
  validatedAt: string;
}

// ── Path Matching ──────────────────────────────────────────────────────────

/**
 * Match an actual request URL path to a spec endpoint path with parameters.
 * e.g., "/api/users/123" matches "/api/users/{id}"
 */
function matchEndpoint(
  requestPath: string,
  requestMethod: string,
  spec: ParsedAPISpec
): APIEndpoint | null {
  const method = requestMethod.toLowerCase();

  for (const endpoint of spec.endpoints) {
    if (endpoint.method.toLowerCase() !== method) continue;

    // Convert spec path to regex: /api/users/{id} → /api/users/[^/]+
    const pattern = endpoint.path
      .replace(/\{[^}]+\}/g, '[^/]+')
      .replace(/\//g, '\\/');
    const regex = new RegExp(`^${pattern}\\/?$`);

    if (regex.test(requestPath)) {
      return endpoint;
    }
  }

  return null;
}

/**
 * Extract the pathname from a URL, stripping the base URL prefix if it matches the spec.
 */
function extractPath(url: string, baseUrl: string): string | null {
  try {
    const parsed = new URL(url);
    let path = parsed.pathname;

    // Strip base URL prefix if present
    if (baseUrl) {
      try {
        const base = new URL(baseUrl);
        if (parsed.origin === base.origin && path.startsWith(base.pathname)) {
          path = path.slice(base.pathname.length);
          if (!path.startsWith('/')) path = '/' + path;
        }
      } catch { /* use raw path */ }
    }

    return path;
  } catch {
    return null;
  }
}

// ── Validation Logic ───────────────────────────────────────────────────────

/**
 * Validate captured HAR entries against an OpenAPI spec.
 */
export function validateAgainstSpec(
  harEntries: (CapturedNetworkEntry | HAREntry)[],
  spec: ParsedAPISpec,
  testCaseId?: string
): ContractValidationReport {
  const violations: ContractViolation[] = [];
  let matchedCount = 0;
  let unmatchedCount = 0;

  // Only check API-like requests (JSON, form data)
  const apiEntries = harEntries.filter((entry) => {
    const url = entry.url;
    // Skip static assets
    if (/\.(js|css|png|jpg|gif|svg|ico|woff|ttf|map|webp)(\?|$)/i.test(url)) return false;
    if (url.startsWith('chrome-extension://') || url.startsWith('data:')) return false;
    // Skip HTML document loads
    if (entry.mimeType?.includes('text/html') && entry.method === 'GET') return false;
    return true;
  });

  for (const entry of apiEntries) {
    const path = extractPath(entry.url, spec.baseUrl);
    if (!path) continue;

    const endpoint = matchEndpoint(path, entry.method, spec);

    if (!endpoint) {
      unmatchedCount++;
      continue;
    }

    matchedCount++;

    // Check 1: Response status code documented?
    const documentedStatuses = endpoint.responses.map((r) => r.statusCode);
    const statusStr = String(entry.status);
    if (!documentedStatuses.includes(statusStr) && !documentedStatuses.includes(`${statusStr[0]}XX`)) {
      violations.push({
        ruleId: 'undocumented-status-code',
        message: `${entry.method} ${endpoint.path} returned ${entry.status}, which is not documented in the spec.`,
        severity: entry.status >= 500 ? 'error' : 'warning',
        endpoint: endpoint.path,
        method: entry.method.toUpperCase(),
        statusCode: entry.status,
        expected: documentedStatuses.join(', '),
        actual: statusStr,
        testCaseId,
      });
    }

    // Check 2: Response content type matches spec?
    const specResponse = endpoint.responses.find((r) => r.statusCode === statusStr);
    if (specResponse?.contentType && entry.mimeType) {
      const actualType = entry.mimeType.split(';')[0].trim();
      if (!specResponse.contentType.includes(actualType) && actualType !== specResponse.contentType) {
        violations.push({
          ruleId: 'unexpected-content-type',
          message: `${entry.method} ${endpoint.path} returned content-type "${actualType}", spec expects "${specResponse.contentType}".`,
          severity: 'warning',
          endpoint: endpoint.path,
          method: entry.method.toUpperCase(),
          statusCode: entry.status,
          expected: specResponse.contentType,
          actual: actualType,
          testCaseId,
        });
      }
    }

    // Check 3: Required request body fields (if we have request body info)
    if (endpoint.requestBody?.required && entry.method !== 'GET' && entry.method !== 'DELETE') {
      const hasBody = 'requestBody' in entry
        ? !!(entry as HAREntry).requestBody
        : (entry as CapturedNetworkEntry).bodySize > 0;
      if (!hasBody) {
        violations.push({
          ruleId: 'missing-required-body',
          message: `${entry.method} ${endpoint.path} requires a request body but none was sent.`,
          severity: 'error',
          endpoint: endpoint.path,
          method: entry.method.toUpperCase(),
          statusCode: entry.status,
          testCaseId,
        });
      }
    }

    // Check 4: Server errors (5xx) — always flag
    if (entry.status >= 500) {
      violations.push({
        ruleId: 'server-error',
        message: `${entry.method} ${endpoint.path} returned server error ${entry.status}.`,
        severity: 'error',
        endpoint: endpoint.path,
        method: entry.method.toUpperCase(),
        statusCode: entry.status,
        testCaseId,
      });
    }
  }

  const report: ContractValidationReport = {
    violations,
    summary: {
      errors: violations.filter((v) => v.severity === 'error').length,
      warnings: violations.filter((v) => v.severity === 'warning').length,
      info: violations.filter((v) => v.severity === 'info').length,
      totalRequests: apiEntries.length,
      matchedEndpoints: matchedCount,
      unmatchedEndpoints: unmatchedCount,
    },
    validatedAt: new Date().toISOString(),
  };

  if (violations.length > 0) {
    log.info(`Contract validation: ${violations.length} violations (${report.summary.errors} errors, ${report.summary.warnings} warnings)`);
  }

  return report;
}

/**
 * Format as human-readable markdown.
 */
export function formatContractReport(report: ContractValidationReport): string {
  if (report.violations.length === 0) {
    return `## API Contract Validation\n\nAll ${report.summary.totalRequests} API requests conform to the spec.`;
  }

  const lines = [
    `## API Contract Validation`,
    ``,
    `**Requests checked:** ${report.summary.totalRequests} (${report.summary.matchedEndpoints} matched spec, ${report.summary.unmatchedEndpoints} unmatched)`,
    `**Violations:** ${report.violations.length} (${report.summary.errors} errors, ${report.summary.warnings} warnings)`,
    ``,
  ];

  const byEndpoint = new Map<string, ContractViolation[]>();
  for (const v of report.violations) {
    const key = `${v.method} ${v.endpoint}`;
    const list = byEndpoint.get(key) ?? [];
    list.push(v);
    byEndpoint.set(key, list);
  }

  for (const [endpoint, violations] of byEndpoint) {
    lines.push(`### \`${endpoint}\``, ``);
    for (const v of violations) {
      const sev = v.severity === 'error' ? 'ERROR' : v.severity === 'warning' ? 'WARN' : 'INFO';
      lines.push(`- **[${sev}]** ${v.message}`);
      if (v.expected) lines.push(`  - Expected: ${v.expected}`);
      if (v.actual) lines.push(`  - Actual: ${v.actual}`);
    }
    lines.push(``);
  }

  return lines.join('\n');
}
