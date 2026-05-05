import { describe, it, expect } from 'vitest';
import { aggregateTrendDaily, compareTrendWindows } from '../../../src/core/reporting/trend-aggregator';
import type { TestRun, TestResult } from '../../../src/storage/schemas';

const tr = (status: TestResult['status'], duration: number, healing: TestResult['healingAttempts'] = []): TestResult => ({
  id: 'r', testCaseId: 'tc', testCaseTitle: 'tc', status,
  startedAt: '2026-05-04T00:00:00Z', duration,
  steps: [], healingAttempts: healing, runId: 'run',
});

const run = (date: string, results: TestResult[]): TestRun => ({
  id: 'run',
  startedAt: `${date}T10:00:00Z`,
  testCaseIds: results.map((r) => r.testCaseId),
  results,
  summary: {
    total: results.length,
    passed: results.filter((r) => r.status === 'passed').length,
    failed: results.filter((r) => r.status === 'failed').length,
    error: results.filter((r) => r.status === 'error').length,
    healed: 0,
  },
} as TestRun);

describe('aggregateTrendDaily', () => {
  it('given runs over multiple days when aggregating then buckets by date', () => {
    const out = aggregateTrendDaily([
      run('2026-05-01', [tr('passed', 100), tr('failed', 200)]),
      run('2026-05-02', [tr('passed', 150)]),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].date).toBe('2026-05-01');
    expect(out[0].passRate).toBe(0.5);
    expect(out[1].passRate).toBe(1);
  });

  it('given healing attempts when aggregating then computes success rate', () => {
    const out = aggregateTrendDaily([
      run('2026-05-01', [tr('passed', 100, [
        { stepOrder: 1, originalSelector: '#a', method: 'similarity', success: true },
        { stepOrder: 2, originalSelector: '#b', method: 'ai', success: false },
      ])]),
    ]);
    expect(out[0].healingAttempts).toBe(2);
    expect(out[0].healingSuccessRate).toBe(0.5);
  });

  it('given empty runs when aggregating then returns empty', () => {
    expect(aggregateTrendDaily([])).toEqual([]);
  });

  it('given p95 calculation when aggregating then approximates correctly', () => {
    const results = Array.from({ length: 20 }, (_, i) => tr('passed', i * 100));
    const out = aggregateTrendDaily([run('2026-05-01', results)]);
    expect(out[0].p95DurationMs).toBeGreaterThanOrEqual(1800);
  });
});

describe('compareTrendWindows', () => {
  function bucket(date: string, passRate: number, mean: number) {
    return {
      date, runs: 1, testTotal: 10, testPassed: passRate * 10, testFailed: 0,
      passRate, meanDurationMs: mean, p95DurationMs: mean,
      healingAttempts: 0, healingSuccess: 0, healingSuccessRate: 0,
    };
  }

  it('given improving pass rate when comparing then improved=true', () => {
    const buckets = [
      ...Array.from({ length: 7 }, (_, i) => bucket(`2026-04-${i + 1}`, 0.5, 100)),
      ...Array.from({ length: 7 }, (_, i) => bucket(`2026-05-${i + 1}`, 0.9, 100)),
    ];
    const deltas = compareTrendWindows(buckets);
    const passDelta = deltas.find((d) => d.metric === 'passRate');
    expect(passDelta?.improved).toBe(true);
  });

  it('given fewer than 2 windows when comparing then empty', () => {
    expect(compareTrendWindows([bucket('2026-05-01', 1, 100)])).toEqual([]);
  });

  it('given regressing latency when comparing then improved=false for mean duration', () => {
    const buckets = [
      ...Array.from({ length: 7 }, (_, i) => bucket(`2026-04-${i + 1}`, 0.9, 100)),
      ...Array.from({ length: 7 }, (_, i) => bucket(`2026-05-${i + 1}`, 0.9, 200)),
    ];
    const deltas = compareTrendWindows(buckets);
    const dur = deltas.find((d) => d.metric === 'meanDurationMs');
    expect(dur?.improved).toBe(false);
  });
});
