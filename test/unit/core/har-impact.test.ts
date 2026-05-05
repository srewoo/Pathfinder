import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the dependencies before importing
vi.mock('../../../src/core/explorer/interaction-graph', () => ({
  loadGraph: vi.fn(),
}));

import { analyzeHARImpact, formatHARImpactReport } from '../../../src/core/analysis/har-impact';
import { loadGraph } from '../../../src/core/explorer/interaction-graph';
import type { TestResult, InteractionGraph } from '../../../src/storage/schemas';

const mockedLoadGraph = vi.mocked(loadGraph);

function makeTestResult(overrides: Partial<TestResult> = {}): TestResult {
  return {
    id: 'tr-1',
    testCaseId: 'tc-1',
    testCaseTitle: 'Test Case 1',
    status: 'passed',
    startedAt: new Date().toISOString(),
    steps: [],
    healingAttempts: [],
    runId: 'run-1',
    harEntries: [],
    ...overrides,
  };
}

describe('HAR Impact Analysis', () => {
  beforeEach(() => {
    mockedLoadGraph.mockReset();
  });

  it('should return 100% coverage when no endpoints are discovered', async () => {
    mockedLoadGraph.mockResolvedValue(null);
    const report = await analyzeHARImpact([]);
    expect(report.summary.totalEndpoints).toBe(0);
    expect(report.summary.coveragePercent).toBe(100);
    expect(report.gaps).toHaveLength(0);
  });

  it('should detect uncovered endpoints from exploration graph', async () => {
    mockedLoadGraph.mockResolvedValue({
      nodes: [
        {
          id: 'n1', url: 'https://app.com/users', title: 'Users', visitedAt: '', elementCount: 5,
          apiEndpoints: [
            { endpoint: 'https://app.com/api/users', method: 'GET', status: 200, context: 'page_load' as const },
            { endpoint: 'https://app.com/api/users', method: 'POST', status: 201, context: 'form_submit' as const },
          ],
        },
      ],
      edges: [],
      createdAt: '',
      updatedAt: '',
    } as InteractionGraph);

    const report = await analyzeHARImpact([]);
    expect(report.summary.totalEndpoints).toBe(2);
    expect(report.summary.coveredEndpoints).toBe(0);
    expect(report.summary.uncoveredEndpoints).toBe(2);
    expect(report.summary.coveragePercent).toBe(0);
    expect(report.gaps).toHaveLength(2);
  });

  it('should mark endpoints as covered when tests exercise them', async () => {
    mockedLoadGraph.mockResolvedValue({
      nodes: [
        {
          id: 'n1', url: 'https://app.com/users', title: 'Users', visitedAt: '', elementCount: 5,
          apiEndpoints: [
            { endpoint: 'https://app.com/api/users', method: 'GET', status: 200, context: 'page_load' as const },
          ],
        },
      ],
      edges: [],
      createdAt: '',
      updatedAt: '',
    } as InteractionGraph);

    const result = makeTestResult({
      harEntries: [
        { url: 'https://app.com/api/users', method: 'GET', status: 200, statusText: 'OK', mimeType: 'application/json', duration: 50, bodySize: 100 },
      ],
    });

    const report = await analyzeHARImpact([result]);
    expect(report.summary.coveredEndpoints).toBe(1);
    expect(report.summary.uncoveredEndpoints).toBe(0);
    expect(report.summary.coveragePercent).toBe(100);
    expect(report.gaps).toHaveLength(0);
  });

  it('should normalize dynamic URL segments for grouping', async () => {
    mockedLoadGraph.mockResolvedValue(null);

    const result = makeTestResult({
      harEntries: [
        { url: 'https://app.com/api/users/123', method: 'GET', status: 200, statusText: 'OK', mimeType: 'application/json', duration: 50, bodySize: 100 },
        { url: 'https://app.com/api/users/456', method: 'GET', status: 200, statusText: 'OK', mimeType: 'application/json', duration: 50, bodySize: 100 },
      ],
    });

    const report = await analyzeHARImpact([result]);
    // Both /users/123 and /users/456 should be grouped into /users/:id
    expect(report.summary.totalEndpoints).toBe(1);
  });

  it('should skip static assets in HAR entries', async () => {
    mockedLoadGraph.mockResolvedValue(null);

    const result = makeTestResult({
      harEntries: [
        { url: 'https://app.com/api/data', method: 'GET', status: 200, statusText: 'OK', mimeType: 'application/json', duration: 50, bodySize: 100 },
        { url: 'https://app.com/style.css', method: 'GET', status: 200, statusText: 'OK', mimeType: 'text/css', duration: 10, bodySize: 500 },
        { url: 'https://app.com/logo.png', method: 'GET', status: 200, statusText: 'OK', mimeType: 'image/png', duration: 10, bodySize: 1000 },
      ],
    });

    const report = await analyzeHARImpact([result]);
    expect(report.summary.totalEndpoints).toBe(1);
  });

  it('should generate a markdown report', async () => {
    mockedLoadGraph.mockResolvedValue(null);
    const report = await analyzeHARImpact([]);
    const markdown = formatHARImpactReport(report);
    expect(markdown).toContain('API Coverage Report');
  });
});
