/**
 * Report Exporter — generates JSON reports and computes test trends
 * for CI/CD integration and dashboard analytics.
 */
import type { TestResult } from '../storage/schemas';
import { testResultDB } from '../storage/indexed-db';

// ---------------------------------------------------------------------------
// JSON Report
// ---------------------------------------------------------------------------

export interface JsonReport {
  version: '1.0';
  generator: 'pathfinder';
  generatedAt: string;
  runId: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
    error: number;
    duration: number;
    passRate: number;
    healedCount: number;
    avgDuration: number;
  };
  results: JsonTestResult[];
}

interface JsonTestResult {
  testCaseId: string;
  testCaseTitle: string;
  status: string;
  duration: number;
  startedAt: string;
  completedAt?: string;
  errorMessage?: string;
  steps: JsonStepResult[];
  healingAttempts: JsonHealingAttempt[];
  networkRequests?: number;
}

interface JsonStepResult {
  order: number;
  action: string;
  description: string;
  status: string;
  duration: number;
  selector?: string;
  error?: string;
  healed?: boolean;
}

interface JsonHealingAttempt {
  stepOrder: number;
  originalSelector: string;
  method: string;
  healedSelector?: string;
  success: boolean;
}

/**
 * Generate a comprehensive JSON report for a test run.
 */
export function generateJsonReport(results: TestResult[]): JsonReport {
  const totalDuration = results.reduce((sum, r) => sum + (r.duration ?? 0), 0);
  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const errored = results.filter((r) => r.status === 'error').length;
  const healedCount = results.filter((r) => r.healingAttempts.length > 0).length;

  return {
    version: '1.0',
    generator: 'pathfinder',
    generatedAt: new Date().toISOString(),
    runId: results[0]?.runId ?? 'unknown',
    summary: {
      total: results.length,
      passed,
      failed,
      error: errored,
      duration: totalDuration,
      passRate: results.length > 0 ? Math.round((passed / results.length) * 100) : 0,
      healedCount,
      avgDuration: results.length > 0 ? Math.round(totalDuration / results.length) : 0,
    },
    results: results.map((r) => ({
      testCaseId: r.testCaseId,
      testCaseTitle: r.testCaseTitle,
      status: r.status,
      duration: r.duration ?? 0,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      errorMessage: r.errorMessage,
      steps: r.steps.map((s) => ({
        order: s.step.order,
        action: s.step.action,
        description: s.step.description,
        status: s.status,
        duration: s.duration,
        selector: s.step.selector,
        error: s.error,
        healed: !!s.healingAttempt?.success,
      })),
      healingAttempts: r.healingAttempts.map((h) => ({
        stepOrder: h.stepOrder,
        originalSelector: h.originalSelector,
        method: h.method,
        healedSelector: h.healedSelector,
        success: h.success,
      })),
      networkRequests: r.harEntries?.length,
    })),
  };
}

// ---------------------------------------------------------------------------
// Test Trends
// ---------------------------------------------------------------------------

export interface TestTrends {
  /** Pass rate per run (last 20 runs) */
  passRateHistory: Array<{ runId: string; date: string; passRate: number; total: number }>;
  /** Tests that have failed/passed inconsistently (flaky) */
  flakyTests: Array<{ testCaseId: string; title: string; passCount: number; failCount: number; flakyScore: number }>;
  /** Average execution time per test (ms) */
  avgDurations: Array<{ testCaseId: string; title: string; avgDuration: number; trend: 'improving' | 'degrading' | 'stable' }>;
  /** Overall stats */
  overall: {
    totalRuns: number;
    avgPassRate: number;
    avgDuration: number;
    mostFailedTest?: { testCaseId: string; title: string; failCount: number };
  };
}

/**
 * Compute test trends from historical results.
 */
export async function computeTestTrends(): Promise<TestTrends> {
  const allResults = await testResultDB.getAll();

  // Group results by runId
  const runMap = new Map<string, TestResult[]>();
  for (const r of allResults) {
    const list = runMap.get(r.runId) ?? [];
    list.push(r);
    runMap.set(r.runId, list);
  }

  // Sort runs by start time (most recent first)
  const runs = Array.from(runMap.entries())
    .map(([runId, results]) => ({
      runId,
      results,
      startedAt: results[0]?.startedAt ?? '',
    }))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 20); // Last 20 runs

  // Pass rate history
  const passRateHistory = runs.map((run) => {
    const passed = run.results.filter((r) => r.status === 'passed').length;
    return {
      runId: run.runId,
      date: run.startedAt.split('T')[0] ?? run.startedAt,
      passRate: run.results.length > 0 ? Math.round((passed / run.results.length) * 100) : 0,
      total: run.results.length,
    };
  }).reverse();

  // Flaky test detection — tests that alternate between pass/fail across runs
  const testHistory = new Map<string, { title: string; passCount: number; failCount: number }>();
  for (const r of allResults) {
    const existing = testHistory.get(r.testCaseId) ?? { title: r.testCaseTitle, passCount: 0, failCount: 0 };
    if (r.status === 'passed') existing.passCount++;
    else existing.failCount++;
    testHistory.set(r.testCaseId, existing);
  }

  const flakyTests = Array.from(testHistory.entries())
    .filter(([, h]) => h.passCount > 0 && h.failCount > 0) // Must have both pass and fail
    .map(([testCaseId, h]) => {
      const total = h.passCount + h.failCount;
      // Flaky score: closer to 50/50 = more flaky (max 1.0)
      const passRatio = h.passCount / total;
      const flakyScore = 1 - Math.abs(passRatio - 0.5) * 2;
      return { testCaseId, title: h.title, passCount: h.passCount, failCount: h.failCount, flakyScore: Math.round(flakyScore * 100) / 100 };
    })
    .sort((a, b) => b.flakyScore - a.flakyScore)
    .slice(0, 10);

  // Average durations with trend
  const testDurations = new Map<string, { title: string; durations: number[] }>();
  for (const r of allResults) {
    if (r.duration === undefined) continue;
    const existing = testDurations.get(r.testCaseId) ?? { title: r.testCaseTitle, durations: [] };
    existing.durations.push(r.duration);
    testDurations.set(r.testCaseId, existing);
  }

  const avgDurations = Array.from(testDurations.entries())
    .filter(([, d]) => d.durations.length >= 2)
    .map(([testCaseId, d]) => {
      const avg = Math.round(d.durations.reduce((s, v) => s + v, 0) / d.durations.length);
      const recent = d.durations.slice(-3);
      const older = d.durations.slice(0, -3);
      const recentAvg = recent.reduce((s, v) => s + v, 0) / recent.length;
      const olderAvg = older.length > 0 ? older.reduce((s, v) => s + v, 0) / older.length : recentAvg;
      const trend = recentAvg > olderAvg * 1.2 ? 'degrading' as const
        : recentAvg < olderAvg * 0.8 ? 'improving' as const
        : 'stable' as const;
      return { testCaseId, title: d.title, avgDuration: avg, trend };
    })
    .sort((a, b) => b.avgDuration - a.avgDuration)
    .slice(0, 10);

  // Most failed test
  const failCounts = Array.from(testHistory.entries())
    .map(([testCaseId, h]) => ({ testCaseId, title: h.title, failCount: h.failCount }))
    .sort((a, b) => b.failCount - a.failCount);

  const overallPassRates = passRateHistory.map((r) => r.passRate);
  const avgPassRate = overallPassRates.length > 0
    ? Math.round(overallPassRates.reduce((s, v) => s + v, 0) / overallPassRates.length)
    : 0;

  const allDurations = allResults.map((r) => r.duration ?? 0);
  const avgDuration = allDurations.length > 0
    ? Math.round(allDurations.reduce((s, v) => s + v, 0) / allDurations.length)
    : 0;

  return {
    passRateHistory,
    flakyTests,
    avgDurations,
    overall: {
      totalRuns: runs.length,
      avgPassRate,
      avgDuration,
      mostFailedTest: failCounts[0]?.failCount > 0 ? failCounts[0] : undefined,
    },
  };
}

/**
 * Get results for a specific run, or the latest run if no runId provided.
 */
export async function getRunResults(runId?: string): Promise<TestResult[]> {
  const allResults = await testResultDB.getAll();

  if (runId) {
    return allResults.filter((r) => r.runId === runId);
  }

  // Find the most recent run
  if (allResults.length === 0) return [];

  const sorted = allResults.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const latestRunId = sorted[0].runId;
  return sorted.filter((r) => r.runId === latestRunId);
}
