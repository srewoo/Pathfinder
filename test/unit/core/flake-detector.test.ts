import { describe, it, expect } from 'vitest';
import { detectFlakes, detectFlakesAcrossSuite } from '../../../src/core/reporting/flake-detector';
import type { TestResult } from '../../../src/storage/schemas';

let counter = 0;
const result = (testCaseId: string, status: TestResult['status'], errMsg?: string): TestResult => ({
  id: `r${++counter}`, testCaseId, testCaseTitle: testCaseId,
  status,
  startedAt: new Date(2026, 0, counter).toISOString(),
  steps: [], healingAttempts: [], runId: 'run',
  ...(errMsg ? { errorMessage: errMsg } : {}),
});

describe('detectFlakes', () => {
  it('given all-pass runs when detecting then not flaky and score 0', () => {
    const stats = detectFlakes('tc1', [
      result('tc1', 'passed'), result('tc1', 'passed'), result('tc1', 'passed'),
    ]);
    expect(stats.isFlaky).toBe(false);
    expect(stats.flakinessScore).toBe(0);
    expect(stats.passes).toBe(3);
  });

  it('given 50/50 mix when detecting then maxes flakiness score', () => {
    const stats = detectFlakes('tc1', [
      result('tc1', 'passed'), result('tc1', 'failed'),
      result('tc1', 'passed'), result('tc1', 'failed'),
    ]);
    expect(stats.flakinessScore).toBeCloseTo(1);
    expect(stats.isFlaky).toBe(true);
  });

  it('given long failure streak when detecting then reports streak', () => {
    const stats = detectFlakes('tc1', [
      result('tc1', 'passed'),
      result('tc1', 'failed'), result('tc1', 'failed'), result('tc1', 'failed'),
      result('tc1', 'passed'),
    ]);
    expect(stats.longestFailStreak).toBe(3);
    expect(stats.longestPassStreak).toBe(1);
  });

  it('given recent failure messages when detecting then dedupes', () => {
    const stats = detectFlakes('tc1', [
      result('tc1', 'failed', 'A'),
      result('tc1', 'failed', 'A'),
      result('tc1', 'failed', 'B'),
    ]);
    expect(stats.lastFailures).toEqual(['B', 'A']);
  });

  it('given out-of-order runs when detecting then sorts chronologically', () => {
    const r1 = result('tc1', 'passed');
    const r2 = result('tc1', 'failed');
    const stats = detectFlakes('tc1', [r2, r1]);
    expect(stats.totalRuns).toBe(2);
  });
});

describe('detectFlakesAcrossSuite', () => {
  it('given runs across multiple cases when detecting then groups + sorts by flakiness', () => {
    const runs = [
      result('stable', 'passed'), result('stable', 'passed'),
      result('flaky', 'passed'), result('flaky', 'failed'),
    ];
    const out = detectFlakesAcrossSuite(runs);
    expect(out[0].testCaseId).toBe('flaky');
    expect(out.find((s) => s.testCaseId === 'stable')?.isFlaky).toBe(false);
  });

  it('given single-run cases when detecting then excludes them', () => {
    const out = detectFlakesAcrossSuite([result('only', 'passed')]);
    expect(out).toEqual([]);
  });
});
