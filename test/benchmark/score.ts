/**
 * Benchmark scoring (fix.md §10).
 *
 * Pure functions, so the metrics are themselves testable. A scoring bug that
 * flatters the tool is worse than no benchmark, because it converts "we don't
 * know" into false confidence.
 */
import type { DefectClass } from './fixtures';
import type { Finding } from '../../src/core/analysis/deterministic-detectors';

export interface FixtureRun {
  fixtureId: string;
  defect: DefectClass;
  /** Findings reported against the CORRECT variant. Any of these is a false positive. */
  onCorrect: Finding[];
  /** Findings reported against the BROKEN variant. */
  onBroken: Finding[];
  /** Wall-clock for both variants, ms. */
  durationMs: number;
  /** Tokens spent. Zero for deterministic detectors — the §9 claim. */
  tokensUsed: number;
}

export interface BenchmarkScore {
  fixtures: number;
  /** Injected defects the detectors caught. */
  truePositives: number;
  /** Injected defects missed. */
  falseNegatives: number;
  /** Findings on correct apps — the adoption-deciding metric. */
  falsePositives: number;
  recall: number;
  /** Share of all findings that were spurious, 0–1. Lower is better. */
  falsePositiveRate: number;
  /** Precision over all reported findings. */
  precision: number;
  totalDurationMs: number;
  totalTokens: number
  perFixture: Array<{
    fixtureId: string;
    defect: DefectClass;
    caught: boolean;
    falsePositives: number;
    /** Findings on the broken variant unrelated to the injected defect. */
    incidentalOnBroken: number;
  }>;
}

/**
 * Does a finding correspond to the injected defect?
 *
 * Matching on `kind` alone is deliberate. Requiring the message to match exact
 * wording would make the score a test of phrasing rather than detection, and
 * would silently drop to zero the first time an error string is reworded.
 */
export function matchesDefect(finding: Finding, defect: DefectClass): boolean {
  const map: Record<DefectClass, Finding['kind']> = {
    'validation-bypass': 'validation-bypass',
    'broken-link': 'broken-link',
    'server-error-on-submit': 'server-error',
    'a11y-missing-label': 'a11y-missing-label',
    'dead-button': 'dead-button',
    'state-not-persisted': 'state-not-persisted',
  };
  return finding.kind === map[defect];
}

export function score(runs: readonly FixtureRun[]): BenchmarkScore {
  let truePositives = 0;
  let falseNegatives = 0;
  let falsePositives = 0;
  let totalDurationMs = 0;
  let totalTokens = 0;

  const perFixture: BenchmarkScore['perFixture'] = [];

  for (const run of runs) {
    const caught = run.onBroken.some((f) => matchesDefect(f, run.defect));
    if (caught) truePositives++;
    else falseNegatives++;

    // Every finding on a correct app is spurious by construction.
    falsePositives += run.onCorrect.length;

    const incidentalOnBroken = run.onBroken.filter((f) => !matchesDefect(f, run.defect)).length;

    totalDurationMs += run.durationMs;
    totalTokens += run.tokensUsed;

    perFixture.push({
      fixtureId: run.fixtureId,
      defect: run.defect,
      caught,
      falsePositives: run.onCorrect.length,
      incidentalOnBroken,
    });
  }

  const reported = truePositives + falsePositives;

  return {
    fixtures: runs.length,
    truePositives,
    falseNegatives,
    falsePositives,
    recall: runs.length === 0 ? 0 : truePositives / runs.length,
    // Denominator is all reported findings, so adding noise hurts even if recall
    // is perfect. That is the point.
    falsePositiveRate: reported === 0 ? 0 : falsePositives / reported,
    precision: reported === 0 ? 0 : truePositives / reported,
    totalDurationMs,
    totalTokens,
    perFixture,
  };
}

// ── Flake ───────────────────────────────────────────────────────────────────

export interface FlakeResult {
  runs: number;
  /** Fixtures whose caught/not-caught verdict differed across runs. */
  unstableFixtures: string[];
  flakeRate: number;
}

/**
 * Compare repeated scorings of the same fixtures.
 *
 * Flake is measured on the VERDICT, not on message text: a detector that finds
 * the defect every time but words it differently is not flaky, and conflating
 * the two would hide real instability behind cosmetic churn.
 */
export function measureFlake(scores: readonly BenchmarkScore[]): FlakeResult {
  if (scores.length < 2) return { runs: scores.length, unstableFixtures: [], flakeRate: 0 };

  const byFixture = new Map<string, Set<boolean>>();
  for (const s of scores) {
    for (const f of s.perFixture) {
      const set = byFixture.get(f.fixtureId) ?? new Set<boolean>();
      set.add(f.caught);
      byFixture.set(f.fixtureId, set);
    }
  }

  const unstable = [...byFixture.entries()].filter(([, v]) => v.size > 1).map(([k]) => k);
  return {
    runs: scores.length,
    unstableFixtures: unstable,
    flakeRate: byFixture.size === 0 ? 0 : unstable.length / byFixture.size,
  };
}

// ── Reporting ───────────────────────────────────────────────────────────────

export function formatScore(s: BenchmarkScore, flake?: FlakeResult): string {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const lines = [
    '── Pathfinder benchmark ──────────────────────────────────────',
    `Fixtures:            ${s.fixtures}`,
    `Recall:              ${pct(s.recall)}  (${s.truePositives} caught, ${s.falseNegatives} missed)`,
    `False positives:     ${s.falsePositives}  (rate ${pct(s.falsePositiveRate)})`,
    `Precision:           ${pct(s.precision)}`,
    `Tokens:              ${s.totalTokens}`,
    `Wall-clock:          ${s.totalDurationMs}ms`,
  ];
  if (flake) {
    lines.push(
      `Flake:               ${pct(flake.flakeRate)} across ${flake.runs} runs` +
        (flake.unstableFixtures.length ? ` — unstable: ${flake.unstableFixtures.join(', ')}` : '')
    );
  }

  lines.push('', 'Per fixture:');
  for (const f of s.perFixture) {
    const mark = f.caught ? '✓' : '✗';
    const fp = f.falsePositives > 0 ? `  [${f.falsePositives} FALSE POSITIVE]` : '';
    const inc = f.incidentalOnBroken > 0 ? `  (+${f.incidentalOnBroken} incidental)` : '';
    lines.push(`  ${mark} ${f.fixtureId.padEnd(26)} ${f.defect}${fp}${inc}`);
  }

  const missed = s.perFixture.filter((f) => !f.caught);
  if (missed.length) {
    lines.push('', `MISSED: ${missed.map((m) => m.fixtureId).join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * CI gate thresholds.
 *
 * False positives are held at zero for the deterministic detectors — they are
 * mechanical checks against ground truth, so any spurious finding is a genuine
 * bug in a detector rather than acceptable noise. Recall is allowed to be
 * imperfect: a missed defect is a gap to close, not a regression to block on.
 */
export const THRESHOLDS = {
  maxFalsePositives: 0,
  minRecall: 0.8,
  maxFlakeRate: 0,
} as const;

export interface GateResult {
  pass: boolean;
  failures: string[];
}

export function gate(s: BenchmarkScore, flake: FlakeResult): GateResult {
  const failures: string[] = [];
  if (s.falsePositives > THRESHOLDS.maxFalsePositives) {
    failures.push(
      `${s.falsePositives} false positive(s) — threshold ${THRESHOLDS.maxFalsePositives}. ` +
        `A detector is reporting a defect in a correct app.`
    );
  }
  if (s.recall < THRESHOLDS.minRecall) {
    failures.push(
      `recall ${Math.round(s.recall * 100)}% below ${Math.round(THRESHOLDS.minRecall * 100)}%`
    );
  }
  if (flake.flakeRate > THRESHOLDS.maxFlakeRate) {
    failures.push(`flake rate ${Math.round(flake.flakeRate * 100)}% — unstable: ${flake.unstableFixtures.join(', ')}`);
  }
  return { pass: failures.length === 0, failures };
}
