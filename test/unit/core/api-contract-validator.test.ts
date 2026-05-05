import { describe, it, expect } from 'vitest';
import { validateAgainstSpec, formatContractReport } from '../../../src/core/analysis/api-contract-validator';
import type { ParsedAPISpec } from '../../../src/core/openapi/openapi-parser';
import type { CapturedNetworkEntry } from '../../../src/storage/schemas';

function makeSpec(overrides: Partial<ParsedAPISpec> = {}): ParsedAPISpec {
  return {
    title: 'Test API',
    version: '1.0.0',
    baseUrl: 'https://api.example.com',
    endpoints: [
      {
        path: '/api/users',
        method: 'get',
        summary: 'List users',
        parameters: [],
        responses: [
          { statusCode: '200', description: 'Success', contentType: 'application/json' },
          { statusCode: '401', description: 'Unauthorized' },
        ],
      },
      {
        path: '/api/users/{id}',
        method: 'get',
        summary: 'Get user by ID',
        parameters: [{ name: 'id', in: 'path', required: true, type: 'integer' }],
        responses: [
          { statusCode: '200', description: 'Success', contentType: 'application/json' },
          { statusCode: '404', description: 'Not found' },
        ],
      },
      {
        path: '/api/users',
        method: 'post',
        summary: 'Create user',
        parameters: [],
        requestBody: { contentType: 'application/json', required: true, properties: [] },
        responses: [
          { statusCode: '201', description: 'Created', contentType: 'application/json' },
          { statusCode: '400', description: 'Bad request' },
        ],
      },
    ],
    summary: 'Test API spec',
    ...overrides,
  };
}

function makeHarEntry(overrides: Partial<CapturedNetworkEntry> = {}): CapturedNetworkEntry {
  return {
    url: 'https://api.example.com/api/users',
    method: 'GET',
    status: 200,
    statusText: 'OK',
    mimeType: 'application/json',
    duration: 50,
    bodySize: 100,
    ...overrides,
  };
}

describe('API Contract Validator', () => {
  it('should pass when all responses match the spec', () => {
    const spec = makeSpec();
    const entries = [
      makeHarEntry({ url: 'https://api.example.com/api/users', method: 'GET', status: 200 }),
    ];

    const report = validateAgainstSpec(entries, spec);
    expect(report.violations).toHaveLength(0);
    expect(report.summary.matchedEndpoints).toBe(1);
  });

  it('should flag undocumented status codes', () => {
    const spec = makeSpec();
    const entries = [
      makeHarEntry({ url: 'https://api.example.com/api/users', method: 'GET', status: 503 }),
    ];

    const report = validateAgainstSpec(entries, spec);
    expect(report.violations.length).toBeGreaterThan(0);
    const statusViolation = report.violations.find((v) => v.ruleId === 'undocumented-status-code');
    expect(statusViolation).toBeDefined();
    expect(statusViolation?.statusCode).toBe(503);
  });

  it('should flag unexpected content types', () => {
    const spec = makeSpec();
    const entries = [
      makeHarEntry({ url: 'https://api.example.com/api/users', method: 'GET', status: 200, mimeType: 'text/plain' }),
    ];

    const report = validateAgainstSpec(entries, spec);
    const ctViolation = report.violations.find((v) => v.ruleId === 'unexpected-content-type');
    expect(ctViolation).toBeDefined();
    expect(ctViolation?.actual).toBe('text/plain');
  });

  it('should match parameterized paths', () => {
    const spec = makeSpec();
    const entries = [
      makeHarEntry({ url: 'https://api.example.com/api/users/42', method: 'GET', status: 200 }),
    ];

    const report = validateAgainstSpec(entries, spec);
    expect(report.summary.matchedEndpoints).toBe(1);
    expect(report.violations).toHaveLength(0);
  });

  it('should flag server errors', () => {
    const spec = makeSpec();
    const entries = [
      makeHarEntry({ url: 'https://api.example.com/api/users', method: 'GET', status: 500 }),
    ];

    const report = validateAgainstSpec(entries, spec);
    const serverError = report.violations.find((v) => v.ruleId === 'server-error');
    expect(serverError).toBeDefined();
  });

  it('should skip static assets', () => {
    const spec = makeSpec();
    const entries = [
      makeHarEntry({ url: 'https://api.example.com/app.js', method: 'GET', status: 200, mimeType: 'application/javascript' }),
      makeHarEntry({ url: 'https://api.example.com/style.css', method: 'GET', status: 200, mimeType: 'text/css' }),
    ];

    const report = validateAgainstSpec(entries, spec);
    expect(report.summary.totalRequests).toBe(0);
  });

  it('should track unmatched endpoints', () => {
    const spec = makeSpec();
    const entries = [
      makeHarEntry({ url: 'https://api.example.com/api/unknown-endpoint', method: 'GET', status: 200 }),
    ];

    const report = validateAgainstSpec(entries, spec);
    expect(report.summary.unmatchedEndpoints).toBe(1);
    expect(report.summary.matchedEndpoints).toBe(0);
  });

  it('should include test case ID in violations', () => {
    const spec = makeSpec();
    const entries = [
      makeHarEntry({ url: 'https://api.example.com/api/users', method: 'GET', status: 500 }),
    ];

    const report = validateAgainstSpec(entries, spec, 'tc-42');
    expect(report.violations[0]?.testCaseId).toBe('tc-42');
  });

  it('should format a readable report', () => {
    const spec = makeSpec();
    const entries = [
      makeHarEntry({ url: 'https://api.example.com/api/users', method: 'GET', status: 500 }),
    ];

    const report = validateAgainstSpec(entries, spec);
    const markdown = formatContractReport(report);
    expect(markdown).toContain('API Contract Validation');
    expect(markdown).toContain('ERROR');
  });

  it('should report clean when no violations', () => {
    const spec = makeSpec();
    const report = validateAgainstSpec([], spec);
    const markdown = formatContractReport(report);
    expect(markdown).toContain('conform to the spec');
  });
});
