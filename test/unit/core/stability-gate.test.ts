import { describe, it, expect, vi } from 'vitest';
import { runStabilityGate } from '../../../src/core/executor/stability-gate';
import type { TestCase, TestResult } from '../../../src/storage/schemas';

const testCase: TestCase = {
  id: 'tc1',
  title: 'User can sign in',
  description: '',
  type: 'positive',
  source: 'generated',
  status: 'pending',
  createdAt: '2026-09-10T00:00:00.000Z',
};

function result(status: TestResult['status'], i: number): TestResult {
  return {
    id: `r${i}`,
    testCaseId: 'tc1',
    testCaseTitle: 'User can sign in',
    status,
    startedAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    duration: 100,
    steps: [],
    healingAttempts: [],
    runId: 'run1',
  };
}

/** Runner that replays a fixed sequence of outcomes. */
function runnerFor(sequence: Array<TestResult['status']>) {
  return vi.fn(async (attempt: number) => result(sequence[attempt], attempt));
}

describe('runStabilityGate', () => {
  it('given_three_passes_then_verdict_is_stable_and_not_quarantined', async () => {
    const report = await runStabilityGate({
      testCase,
      run: runnerFor(['passed', 'passed', 'passed']),
    });
    expect(report.verdict).toBe('stable');
    expect(report.quarantine).toBe(false);
    expect(report.runs).toHaveLength(3);
  });

  it('given_pass_fail_pass_then_verdict_is_unstable_and_quarantined', async () => {
    const report = await runStabilityGate({
      testCase,
      run: runnerFor(['passed', 'failed', 'passed']),
    });
    expect(report.verdict).toBe('unstable');
    expect(report.quarantine).toBe(true);
  });

  // All-failing is a broken test, not a flaky one. Quarantine would hide it;
  // the user needs to see it fail.
  it('given_three_failures_then_verdict_is_failing_and_not_quarantined', async () => {
    const report = await runStabilityGate({
      testCase,
      run: runnerFor(['failed', 'failed', 'failed']),
    });
    expect(report.verdict).toBe('failing');
    expect(report.quarantine).toBe(false);
  });

  it('given_an_error_outcome_mixed_with_a_pass_then_verdict_is_unstable', async () => {
    const report = await runStabilityGate({
      testCase,
      run: runnerFor(['passed', 'error', 'passed']),
    });
    expect(report.verdict).toBe('unstable');
  });

  it('given_attempts_of_one_then_one_run_and_a_stable_verdict', async () => {
    const run = runnerFor(['passed']);
    const report = await runStabilityGate({ testCase, attempts: 1, run });
    expect(run).toHaveBeenCalledTimes(1);
    expect(report.verdict).toBe('stable');
    expect(report.quarantine).toBe(false);
  });

  it('given_attempts_of_five_then_it_runs_five_times', async () => {
    const run = runnerFor(['passed', 'passed', 'passed', 'passed', 'passed']);
    await runStabilityGate({ testCase, attempts: 5, run });
    expect(run).toHaveBeenCalledTimes(5);
  });

  it('given_attempts_below_one_then_it_still_runs_once', async () => {
    const run = runnerFor(['passed']);
    await runStabilityGate({ testCase, attempts: 0, run });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('given_an_aborted_signal_then_it_stops_early_and_judges_what_it_has', async () => {
    const controller = new AbortController();
    const run = vi.fn(async (attempt: number) => {
      if (attempt === 1) controller.abort();
      return result('passed', attempt);
    });
    const report = await runStabilityGate({
      testCase,
      attempts: 5,
      run,
      signal: controller.signal,
    });
    expect(run.mock.calls.length).toBeLessThan(5);
    expect(report.runs.length).toBeGreaterThan(0);
  });

  it('given_a_verdict_then_the_summary_names_the_outcome_counts', async () => {
    const report = await runStabilityGate({
      testCase,
      run: runnerFor(['passed', 'failed', 'passed']),
    });
    expect(report.summary).toMatch(/2 passed/);
    expect(report.summary).toMatch(/1 failed/);
    expect(report.summary).toMatch(/unstable/);
  });

  // A crashed attempt is evidence of instability, not a reason to abandon the
  // gate.
  it('given_a_runner_that_throws_then_the_attempt_counts_as_an_error_not_a_crash', async () => {
    const run = vi.fn(async (attempt: number) => {
      if (attempt === 1) throw new Error('tab closed');
      return result('passed', attempt);
    });
    const report = await runStabilityGate({ testCase, run });
    expect(report.runs).toHaveLength(3);
    expect(report.runs[1].status).toBe('error');
    expect(report.runs[1].errorMessage).toBe('tab closed');
    expect(report.verdict).toBe('unstable');
  });

  it('given_runs_then_flake_stats_are_computed_from_them', async () => {
    const report = await runStabilityGate({
      testCase,
      run: runnerFor(['passed', 'failed', 'passed']),
    });
    expect(report.flake.totalRuns).toBe(3);
    expect(report.flake.passes).toBe(2);
    expect(report.flake.failures).toBe(1);
  });
});
