/**
 * Roll up TestRun history into trend metrics suitable for dashboard charts.
 *
 * - Pass rate over time, bucketed by day.
 * - Mean and p95 duration over time.
 * - Healing-success rate over time (a leading indicator of selector decay).
 *
 * Pure functions — caller decides the data source (IndexedDB, API, etc).
 */

import type { TestRun } from '../../storage/schemas';

export interface TrendBucket {
  /** ISO date (YYYY-MM-DD) of the bucket's day. */
  date: string;
  runs: number;
  testTotal: number;
  testPassed: number;
  testFailed: number;
  passRate: number;
  meanDurationMs: number;
  p95DurationMs: number;
  healingAttempts: number;
  healingSuccess: number;
  /** 0..1 — share of healing attempts that succeeded. */
  healingSuccessRate: number;
}

export function aggregateTrendDaily(runs: TestRun[]): TrendBucket[] {
  const byDate = new Map<string, TestRun[]>();
  for (const r of runs) {
    const date = isoDate(r.startedAt);
    if (!date) continue;
    const list = byDate.get(date);
    if (list) list.push(r);
    else byDate.set(date, [r]);
  }

  const buckets: TrendBucket[] = [];
  for (const [date, dayRuns] of byDate) {
    const allDurations: number[] = [];
    let testTotal = 0;
    let testPassed = 0;
    let testFailed = 0;
    let healingAttempts = 0;
    let healingSuccess = 0;

    for (const run of dayRuns) {
      for (const result of run.results) {
        testTotal++;
        if (result.status === 'passed') testPassed++;
        else if (result.status === 'failed') testFailed++;
        if (result.duration != null) allDurations.push(result.duration);
        for (const ha of result.healingAttempts ?? []) {
          healingAttempts++;
          if (ha.success) healingSuccess++;
        }
      }
    }

    const sortedDurations = allDurations.slice().sort((a, b) => a - b);
    buckets.push({
      date,
      runs: dayRuns.length,
      testTotal,
      testPassed,
      testFailed,
      passRate: testTotal === 0 ? 0 : testPassed / testTotal,
      meanDurationMs: mean(allDurations),
      p95DurationMs: percentile(sortedDurations, 0.95),
      healingAttempts,
      healingSuccess,
      healingSuccessRate: healingAttempts === 0 ? 0 : healingSuccess / healingAttempts,
    });
  }

  buckets.sort((a, b) => a.date.localeCompare(b.date));
  return buckets;
}

export interface TrendDelta {
  metric: keyof Omit<TrendBucket, 'date'>;
  recent: number;
  previous: number;
  /** Positive = improvement for "good" metrics (pass rate up, healing up); negative for duration. */
  changePct: number;
  /** Bool guidance for UI colouring. */
  improved: boolean;
}

const HIGHER_IS_BETTER: Array<keyof Omit<TrendBucket, 'date'>> = [
  'passRate', 'healingSuccessRate', 'testPassed', 'runs',
];

export function compareTrendWindows(
  buckets: TrendBucket[],
  windowSize = 7,
): TrendDelta[] {
  if (buckets.length < windowSize * 2) return [];
  const recent = buckets.slice(-windowSize);
  const previous = buckets.slice(-windowSize * 2, -windowSize);
  const metrics: Array<keyof Omit<TrendBucket, 'date'>> = [
    'passRate', 'meanDurationMs', 'p95DurationMs', 'healingSuccessRate',
  ];
  return metrics.map((m) => {
    const recentMean = mean(recent.map((b) => Number(b[m])));
    const prevMean = mean(previous.map((b) => Number(b[m])));
    const changePct = prevMean === 0 ? 0 : ((recentMean - prevMean) / prevMean) * 100;
    const higherBetter = HIGHER_IS_BETTER.includes(m);
    const improved = higherBetter ? changePct >= 0 : changePct <= 0;
    return { metric: m, recent: recentMean, previous: prevMean, changePct, improved };
  });
}

function isoDate(s: string | undefined): string | null {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}
