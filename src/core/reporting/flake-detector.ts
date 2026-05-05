/**
 * Flake detection across multiple runs of the same test case.
 *
 * A test is "flaky" when its outcome changes across runs without the underlying
 * code changing. We compute:
 *   • flakiness score: fraction of runs where the result disagreed with the
 *     test's modal (most common) outcome.
 *   • streaks: longest consecutive pass / fail runs.
 *   • lastFailures: most recent failure messages (deduped) for context.
 *
 * No assumption about persistence layer — caller passes in TestResult[]
 * already filtered to a single test case.
 */

import type { TestResult } from '../../storage/schemas';

export interface FlakeStats {
  testCaseId: string;
  testCaseTitle: string;
  totalRuns: number;
  passes: number;
  failures: number;
  errors: number;
  /** 0 = stable, 1 = maximally flaky (50/50 split). */
  flakinessScore: number;
  /** True when score > FLAKE_THRESHOLD AND there's at least one of each outcome. */
  isFlaky: boolean;
  longestPassStreak: number;
  longestFailStreak: number;
  lastFailures: string[];
}

const FLAKE_THRESHOLD = 0.15;

export function detectFlakes(testCaseId: string, runs: TestResult[]): FlakeStats {
  // Sort chronologically — oldest first
  const ordered = [...runs].sort(
    (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
  );

  const total = ordered.length;
  let passes = 0;
  let failures = 0;
  let errors = 0;
  for (const r of ordered) {
    if (r.status === 'passed') passes++;
    else if (r.status === 'failed') failures++;
    else if (r.status === 'error') errors++;
  }

  const modal = Math.max(passes, failures, errors);
  const minorityFraction = total === 0 ? 0 : (total - modal) / total;
  // 50/50 → minorityFraction = 0.5 → score 1.0; 100/0 → score 0.0
  const flakinessScore = Math.min(1, minorityFraction * 2);
  const hasMixedOutcomes = (passes > 0 ? 1 : 0) + (failures > 0 ? 1 : 0) + (errors > 0 ? 1 : 0) > 1;

  return {
    testCaseId,
    testCaseTitle: ordered[ordered.length - 1]?.testCaseTitle ?? 'unknown',
    totalRuns: total,
    passes,
    failures,
    errors,
    flakinessScore,
    isFlaky: hasMixedOutcomes && flakinessScore >= FLAKE_THRESHOLD,
    longestPassStreak: longestStreak(ordered, 'passed'),
    longestFailStreak: longestStreak(ordered, 'failed'),
    lastFailures: pickLastFailures(ordered, 5),
  };
}

/**
 * Run flake detection across many test cases. Input is the entire flat result
 * history; we group internally by testCaseId.
 */
export function detectFlakesAcrossSuite(allRuns: TestResult[]): FlakeStats[] {
  const byCase = new Map<string, TestResult[]>();
  for (const r of allRuns) {
    const list = byCase.get(r.testCaseId);
    if (list) list.push(r);
    else byCase.set(r.testCaseId, [r]);
  }
  const results: FlakeStats[] = [];
  for (const [id, runs] of byCase) {
    if (runs.length >= 2) results.push(detectFlakes(id, runs));
  }
  // Highest flakiness first
  results.sort((a, b) => b.flakinessScore - a.flakinessScore);
  return results;
}

function longestStreak(runs: TestResult[], status: TestResult['status']): number {
  let cur = 0;
  let best = 0;
  for (const r of runs) {
    if (r.status === status) {
      cur++;
      if (cur > best) best = cur;
    } else {
      cur = 0;
    }
  }
  return best;
}

function pickLastFailures(runs: TestResult[], n: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = runs.length - 1; i >= 0 && out.length < n; i--) {
    const msg = runs[i].errorMessage;
    if (!msg || seen.has(msg)) continue;
    seen.add(msg);
    out.push(msg);
  }
  return out;
}
