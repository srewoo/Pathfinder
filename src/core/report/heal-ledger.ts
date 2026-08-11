/**
 * Heal ledger and the NEEDS_REVIEW verdict (fix.md §5).
 *
 * "Every heal is surfaced in the report" is not a logging preference — silent
 * healing is how a test keeps passing while asserting nothing, which is the worst
 * failure mode this product has. A test that quietly re-pointed two locators is
 * not a pass; it is a result nobody has looked at yet.
 */
import type { Locator, LocatorTier } from '../locator';
import { describeLocator, isTestabilityGap, locatorKey } from '../locator';

export interface HealEvent {
  at: number;
  testId: string;
  stepOrder: number;
  locatorKey: string;
  target: string;
  /** Tier the locator preferred. */
  from: LocatorTier;
  /** Tier that actually resolved. */
  to: LocatorTier;
}

/** Heals at or above this count in one test downgrade it to NEEDS_REVIEW. */
export const NEEDS_REVIEW_HEAL_THRESHOLD = 2;

export type TestVerdict = 'PASS' | 'NEEDS_REVIEW' | 'FAIL';

export interface HealLedger {
  record(event: Omit<HealEvent, 'at'>, at: number): void;
  events(): readonly HealEvent[];
  forTest(testId: string): readonly HealEvent[];
  /** Distinct locators healed in a test — repeats of one locator count once. */
  healedLocatorCount(testId: string): number;
  clear(): void;
}

export function createHealLedger(): HealLedger {
  const events: HealEvent[] = [];

  return {
    record(event, at) {
      events.push({ ...event, at });
    },
    events() {
      return events;
    },
    forTest(testId) {
      return events.filter((e) => e.testId === testId);
    },
    healedLocatorCount(testId) {
      // Count distinct locators, not events: one flaky locator retried three
      // times is a single testability problem, not three.
      return new Set(events.filter((e) => e.testId === testId).map((e) => e.locatorKey)).size;
    },
    clear() {
      events.length = 0;
    },
  };
}

/**
 * Final verdict for a test.
 *
 * A failure stays a failure regardless of heals. A pass that leaned on two or
 * more healed locators becomes NEEDS_REVIEW: it may be correct, but the evidence
 * that it tested what it claims has weakened.
 */
export function verdictFor(
  stepsPassed: boolean,
  healedLocators: number,
  threshold = NEEDS_REVIEW_HEAL_THRESHOLD
): TestVerdict {
  if (!stepsPassed) return 'FAIL';
  return healedLocators >= threshold ? 'NEEDS_REVIEW' : 'PASS';
}

export function explainVerdict(verdict: TestVerdict, healedLocators: number): string {
  switch (verdict) {
    case 'FAIL':
      return 'One or more steps or assertions failed.';
    case 'NEEDS_REVIEW':
      return (
        `Passed, but ${healedLocators} locator(s) had to be healed to get there. ` +
        `The test may no longer be exercising what it was written for — confirm before trusting it.`
      );
    case 'PASS':
      return 'All steps and assertions passed with no locator healing.';
  }
}

// ── Testability report (§5.1) ───────────────────────────────────────────────

export interface TestabilityGap {
  target: string;
  locatorKey: string;
  /** Pages the element was needed on. */
  urls: string[];
  /** How many steps depended on it — the priority signal. */
  usageCount: number;
}

export interface TestabilityReport {
  totalLocators: number;
  durableLocators: number;
  gaps: TestabilityGap[];
  /** Share of locators resolvable by a durable tier, 0–1. */
  score: number;
}

export interface LocatorUsage {
  locator: Locator;
  url?: string;
}

/**
 * Build the report from every locator a run used.
 *
 * Telling a team which elements lack stable identifiers is a legitimate product
 * output, not an admission of failure — it is the single highest-leverage change
 * they can make to their own testability.
 */
export function buildTestabilityReport(usages: readonly LocatorUsage[]): TestabilityReport {
  const gaps = new Map<string, TestabilityGap>();
  let durable = 0;

  for (const { locator, url } of usages) {
    if (!isTestabilityGap(locator)) {
      durable++;
      continue;
    }
    const key = locatorKey(locator);
    const existing = gaps.get(key);
    if (existing) {
      existing.usageCount++;
      if (url && !existing.urls.includes(url)) existing.urls.push(url);
    } else {
      gaps.set(key, {
        target: describeLocator(locator),
        locatorKey: key,
        urls: url ? [url] : [],
        usageCount: 1,
      });
    }
  }

  const total = usages.length;
  return {
    totalLocators: total,
    durableLocators: durable,
    // Most-used gaps first: that ordering is the remediation plan.
    gaps: [...gaps.values()].sort((a, b) => b.usageCount - a.usageCount),
    score: total === 0 ? 1 : durable / total,
  };
}

export function formatTestabilityReport(report: TestabilityReport): string {
  const pct = Math.round(report.score * 100);
  const lines = [
    `Testability: ${pct}% of locators are durable (${report.durableLocators}/${report.totalLocators}).`,
  ];

  if (report.gaps.length === 0) {
    lines.push('No gaps — every element was reachable by test id or accessible name.');
    return lines.join('\n');
  }

  lines.push(
    '',
    `${report.gaps.length} element(s) could only be found by CSS selector. Adding a`,
    '`data-testid` (or an accessible name) to these would make tests durable:',
    ''
  );
  for (const gap of report.gaps.slice(0, 25)) {
    const where = gap.urls.length ? ` — on ${gap.urls.slice(0, 3).join(', ')}` : '';
    lines.push(`  • ${gap.target} (used by ${gap.usageCount} step(s))${where}`);
  }
  if (report.gaps.length > 25) {
    // Never let a cap read as "that was everything".
    lines.push(`  … and ${report.gaps.length - 25} more`);
  }
  return lines.join('\n');
}
