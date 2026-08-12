/**
 * Adapt legacy `TestResult` to the export shape (fix.md §5, §11).
 *
 * This is the bridge that gets §5's heal reporting into the product *now*,
 * without waiting for the full IR migration: `StepResult.healingAttempt` already
 * records every successful heal, so the `NEEDS_REVIEW` verdict can be computed
 * from data the legacy executor has always produced but never surfaced.
 *
 * That was the actual gap. Healing was not missing — it was silent.
 */
import type { HealingAttempt, StepResult, TestResult } from '../../storage/schemas';
import type { ExportRun, ExportStep, ExportTestResult } from './junit-export';
import { verdictFor, type TestVerdict } from './heal-ledger';
import type { LedgerSummary } from '../safety/mutation-ledger';
import type { TestabilityReport } from './heal-ledger';
import { buildTestabilityReport, type LocatorUsage } from './heal-ledger';
import { fromCss, fromTestId } from '../locator';

/**
 * Distinct locators that had to be healed for this test to pass.
 *
 * Counted by original selector, not by attempt: one flaky locator retried three
 * times is a single testability problem, not three (§5).
 */
export function healedLocatorCount(
  steps: readonly StepResult[],
  runLevel: readonly HealingAttempt[] = []
): number {
  const healed = new Set<string>();
  // Both sources are consulted: per-step `healingAttempt` and the run-level
  // `healingAttempts` array. They overlap in practice, and a Set keyed by the
  // original selector collapses the duplication — reading only one would
  // undercount depending on which path recorded the heal.
  for (const s of steps) {
    if (s.healingAttempt?.success) healed.add(s.healingAttempt.originalSelector);
  }
  for (const h of runLevel) {
    if (h.success) healed.add(h.originalSelector);
  }
  return healed.size;
}

export function verdictOf(result: TestResult): TestVerdict {
  const passed = result.status === 'passed';
  return verdictFor(passed, healedLocatorCount(result.steps ?? [], result.healingAttempts ?? []));
}

function toExportStep(s: StepResult): ExportStep {
  return {
    order: s.step.order,
    description: s.step.description,
    status: s.status,
    durationMs: s.duration,
    error: s.error,
    healed: s.healingAttempt?.success
      ? {
          // The legacy healer works on CSS selectors only, so the tier
          // transition is always structural→structural. Reporting the selectors
          // is what makes the heal reviewable.
          from: s.healingAttempt.originalSelector,
          to: s.healingAttempt.healedSelector ?? '(unknown)',
        }
      : undefined,
  };
}

/**
 * Verdict, accounting for oracle findings.
 *
 * A high-severity finding downgrades a PASS to NEEDS_REVIEW. "No assertion failed"
 * is a weaker claim than "nothing went wrong": a test whose banner assertion passed
 * while nothing was persisted should not report a clean pass. It is not marked FAIL
 * — the test did what it was told — but it must not read as green either.
 */
export function verdictWithOracles(result: TestResult): TestVerdict {
  const base = verdictOf(result);
  if (base === 'FAIL') return 'FAIL';
  const serious = (result.oracleFindings ?? []).filter((f) => f.severity === 'high');
  return serious.length > 0 ? 'NEEDS_REVIEW' : base;
}

export function toExportResult(result: TestResult): ExportTestResult {
  const findings = result.oracleFindings ?? [];
  return {
    id: result.testCaseId,
    name: result.testCaseTitle,
    verdict: verdictWithOracles(result),
    durationMs: result.duration ?? 0,
    startedAt: result.startedAt,
    steps: (result.steps ?? []).map(toExportStep),
    // Folded into the message so a finding cannot be lost just because the
    // reader only looks at the failure text.
    errorMessage:
      findings.length > 0
        ? [
            result.errorMessage,
            ...findings.map((f) => `[${f.kind}] ${f.message} — ${f.evidence}`),
          ]
            .filter(Boolean)
            .join('\n')
        : result.errorMessage,
    healedLocatorCount: healedLocatorCount(result.steps ?? [], result.healingAttempts ?? []),
  };
}

export interface RunContext {
  runId?: string;
  suiteName?: string;
  mutations?: LedgerSummary;
  testability?: TestabilityReport;
}

export function toExportRun(results: readonly TestResult[], ctx: RunContext = {}): ExportRun {
  const startedAt = results[0]?.startedAt ?? new Date(0).toISOString();
  return {
    runId: ctx.runId ?? 'run',
    suiteName: ctx.suiteName ?? 'Pathfinder',
    startedAt,
    durationMs: results.reduce((sum, r) => sum + (r.duration ?? 0), 0),
    results: results.map(toExportResult),
    mutations: ctx.mutations
      ? {
          permitted: ctx.mutations.mutationsPermitted,
          refused: ctx.mutations.requestsRefused,
          changedEndpoints: ctx.mutations.changedEndpoints,
        }
      : undefined,
    testability: ctx.testability
      ? { score: ctx.testability.score, gapCount: ctx.testability.gaps.length }
      : undefined,
  };
}

/**
 * Approximate a testability report from executed steps.
 *
 * The legacy pipeline stores bare CSS selectors, not structured locators, so this
 * infers the tier: a `[data-testid=...]` selector is durable, anything else is a
 * gap. That under-counts durability (a selector like `[aria-label="Save"]` is
 * reasonably stable but scores as a gap) and it cannot see accessible names at
 * all — so it is a floor, not a measurement.
 *
 * Called out because a report that looks precise and isn't is worse than one
 * labelled approximate. Exact numbers arrive with the IR path (§6), where
 * locators are structured.
 */
export function approximateTestability(results: readonly TestResult[]): TestabilityReport {
  const usages: LocatorUsage[] = [];

  for (const result of results) {
    for (const step of result.steps ?? []) {
      const selector = step.step.selector;
      if (!selector) continue;
      const testid = /\[data-testid=["']?([^"'\]]+)["']?\]/.exec(selector);
      usages.push({
        locator: testid ? fromTestId(testid[1]) : fromCss(selector),
      });
    }
  }

  return buildTestabilityReport(usages);
}
