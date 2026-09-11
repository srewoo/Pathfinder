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
import {
  verdictFor,
  explainVerdict,
  NEEDS_REVIEW_HEAL_THRESHOLD,
  type TestVerdict,
} from './heal-ledger';
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

/**
 * Lifecycle states that have not produced an assessable outcome yet.
 *
 * Kept apart from the verdict on purpose: a test that is still running has not
 * failed, and counting it as one makes a run in progress look broken.
 */
export function isIncomplete(result: TestResult): boolean {
  // `running` is the only non-terminal status a stored result can carry — a test
  // that has not started yet has no result record at all.
  return result.status === 'running';
}

/**
 * Did every step that actually ran succeed?
 *
 * The stored `status` alone is not trusted, because results written before the
 * generated-assertion fix carry `passed` alongside a step that visibly failed.
 * Deriving from the steps makes those records tell the truth without a
 * destructive migration, and it is the same rule for new records.
 *
 * `skipped` is not a failure: a resumed run records its prefix that way.
 */
function stepsAllPassed(result: TestResult): boolean {
  return !(result.steps ?? []).some((s) => s.status === 'failed');
}

/**
 * Did the failing step target something exploration never observed?
 *
 * Read off the stored step rather than recomputed: a failed step that carries no
 * selector, or one whose plan came from an inferred description, cannot be
 * distinguished from a real regression by its error text alone.
 *
 * Conservative — it claims this only when the evidence is on the result, so a
 * record from before grounding was tracked reads as a normal failure rather
 * than being excused.
 */
export function failedOnInferredSelector(result: TestResult): boolean {
  const failed = (result.steps ?? []).find((s) => s.status === 'failed');
  if (!failed) return false;
  return failed.groundedAtAuthoring === false;
}

/** A verdict together with the reason a human needs to act on it. */
export interface VerdictReason {
  verdict: TestVerdict;
  reason: string;
}

/**
 * The canonical assessment of a completed result — the single computation.
 *
 * Precedence, highest first:
 *   1. a failed step, a non-passing stored status, or cancellation → FAIL
 *   2. a high-severity oracle finding                             → NEEDS_REVIEW
 *   3. the distinct-healed-locator threshold                      → NEEDS_REVIEW
 *   4. otherwise                                                  → PASS
 *
 * Lower-severity findings are reported but never change the verdict: promoting
 * them without a defined policy would make the strongest signal in the product
 * mean less.
 */
export function verdictWithReason(result: TestResult): VerdictReason {
  const healed = healedLocatorCount(result.steps ?? [], result.healingAttempts ?? []);
  const passed = result.status === 'passed' && stepsAllPassed(result);

  if (!passed) {
    const failedStep = (result.steps ?? []).find((s) => s.status === 'failed');
    const base =
      result.errorMessage ??
      failedStep?.error ??
      (failedStep
        ? `Step ${failedStep.step.order} failed.`
        : result.status === 'error'
          ? 'The test could not run to completion.'
          : 'One or more steps or assertions failed.');
    // A failure on a selector nothing ever observed is a generation gap, not a
    // product defect, and the two are indistinguishable without saying so. The
    // note is additive: the underlying error is still reported in full.
    const reason = failedOnInferredSelector(result)
      ? `${base} — this step targets an element exploration never recorded, so the ` +
        `test is the more likely cause than the application. Explore the page and regenerate.`
      : base;
    return { verdict: 'FAIL', reason };
  }

  const serious = (result.oracleFindings ?? []).filter((f) => f.severity === 'high');
  if (serious.length > 0) {
    // "No assertion failed" is a weaker claim than "nothing went wrong". A test
    // whose banner assertion passed while nothing was persisted must not read
    // as green, but it did what it was told, so it is not a FAIL either.
    const first = serious[0];
    return {
      verdict: 'NEEDS_REVIEW',
      reason:
        `Passed, but an oracle found a problem the test did not check for ` +
        // The kind is the label a reader can search for and group by; the
        // message alone reads as prose and cannot be triaged.
        `[${first.kind}]: ${first.message} (${first.evidence}).` +
        (serious.length > 1 ? ` ${serious.length - 1} more finding(s).` : ''),
    };
  }

  if (healed >= NEEDS_REVIEW_HEAL_THRESHOLD) {
    return { verdict: 'NEEDS_REVIEW', reason: explainVerdict('NEEDS_REVIEW', healed) };
  }

  return {
    verdict: 'PASS',
    reason: healed > 0
      ? `Passed. ${healed} locator was healed along the way.`
      : 'Passed with no healing and no findings.',
  };
}

/**
 * Verdict ignoring oracle findings.
 *
 * Retained because callers exist; it shares the step-derivation fix so it can no
 * longer report a pass for a record whose steps failed.
 */
export function verdictOf(result: TestResult): TestVerdict {
  const passed = result.status === 'passed' && stepsAllPassed(result);
  return verdictFor(passed, healedLocatorCount(result.steps ?? [], result.healingAttempts ?? []));
}

export interface VerdictCounts {
  pass: number;
  needsReview: number;
  fail: number;
  /** Still running or not yet started — deliberately not a verdict. */
  incomplete: number;
  total: number;
}

/**
 * The counts every surface must show.
 *
 * One function so the dashboard, the HTML report and the JUnit summary cannot
 * drift apart — which they had, because the side panel counted `result.status`
 * while exports counted verdicts.
 */
export function summarizeVerdicts(results: readonly TestResult[]): VerdictCounts {
  const counts: VerdictCounts = { pass: 0, needsReview: 0, fail: 0, incomplete: 0, total: results.length };
  for (const r of results) {
    if (isIncomplete(r)) {
      counts.incomplete++;
      continue;
    }
    switch (verdictWithReason(r).verdict) {
      case 'PASS':
        counts.pass++;
        break;
      case 'NEEDS_REVIEW':
        counts.needsReview++;
        break;
      default:
        counts.fail++;
    }
  }
  return counts;
}


/** How a test reached its final outcome, when it took more than one attempt. */
export interface RetrySummary {
  attempts: number;
  /** Zero-based index of the attempt that finally passed, if one did. */
  passedOnAttempt?: number;
  /** True when earlier attempts failed and a later one passed. */
  retriedToPass: boolean;
  /** One line for a card. */
  label: string;
}

/**
 * Read the attempt ledger.
 *
 * Deliberately NOT folded into the verdict. A test that needed two goes is a
 * diagnostic signal, not a review requirement — promoting it to NEEDS_REVIEW
 * would need a stated policy about how much retrying is acceptable, and
 * inventing one here would quietly reclassify a large share of existing passes.
 * It is surfaced beside the verdict instead.
 *
 * Absence means not retried, not unknown: a first-attempt pass stores no ledger,
 * and so does a record written before this was tracked.
 */
export function retrySummary(result: TestResult): RetrySummary | undefined {
  const attempts = result.attempts ?? [];
  if (attempts.length <= 1) return undefined;

  const passing = attempts.findIndex((a) => a.status === 'passed');
  const retriedToPass = passing > 0;
  return {
    attempts: attempts.length,
    passedOnAttempt: passing >= 0 ? passing : undefined,
    retriedToPass,
    label: retriedToPass
      ? `Passed on attempt ${passing + 1} of ${attempts.length}`
      : `Failed after ${attempts.length} attempts`,
  };
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
  return verdictWithReason(result).verdict;
}

export function toExportResult(result: TestResult): ExportTestResult {
  const findings = result.oracleFindings ?? [];
  const assessed = verdictWithReason(result);
  return {
    id: result.testCaseId,
    name: result.testCaseTitle,
    verdict: assessed.verdict,
    verdictReason: assessed.reason,
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
    retry: retrySummary(result),
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

/**
 * Order of the earliest failing step — the resume point for a debugging re-run.
 *
 * `skipped` is deliberately not treated as a failure: a result produced by an
 * already-resumed run carries a skipped prefix, and counting those would walk
 * the resume point backwards on every re-run until it reached the start again.
 */
export function firstFailingStepOrder(result: TestResult): number | undefined {
  const failing = (result.steps ?? [])
    .filter((s) => s.status === 'failed')
    .map((s) => s.step.order)
    .sort((a, b) => a - b);
  return failing[0];
}
