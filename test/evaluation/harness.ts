/**
 * The measurement harness.
 *
 * Runs every scenario against both variants and reports counts with their
 * denominators. The numbers it produces are the point — not a pass/fail — so
 * the report states the tier it ran on, and a reader can tell at a glance which
 * claims it does and does not support.
 */
import { resolve } from 'node:path';
import { JsdomDriver } from './jsdom-driver';
import { SCENARIOS, type Scenario, type ScenarioOutcome } from './scenarios';

const FIXTURE_ROOT = resolve(__dirname, 'fixture-app');

/**
 * Which claims a set of results can support.
 *
 * The distinction is the plan's, and it matters: a number from `mocked` says
 * something about the code's internal consistency, a number from
 * `deterministic-dom` says the engine reaches the right conclusion against real
 * HTML and real scripts, and only `real-browser` says anything about the
 * product working in Chrome. `live-model` additionally exercises generation.
 */
export type EvaluationTier = 'mocked' | 'deterministic-dom' | 'real-browser' | 'live-model';

export const TIER_CAVEATS: Record<EvaluationTier, string> = {
  mocked: 'Hand-built page models. Says nothing about real HTML, layout or scripts.',
  'deterministic-dom':
    'Real HTML with the page scripts executing, engine code unstubbed. No layout, ' +
    'no trusted input, no real network — see jsdom-driver.ts for the full list.',
  'real-browser':
    'The built extension in Chrome against a served fixture. Covers layout, trusted ' +
    'input and the real network path.',
  'live-model':
    'A real model generating the tests. Results vary run to run; the model, ' +
    'settings, prompt versions and sample size must be recorded alongside.',
};

/** One scenario against one variant, once. */
export interface RunRecord {
  scenarioId: string;
  kind: Scenario['kind'];
  variant: 'correct' | 'broken';
  repeat: number;
  outcome: ScenarioOutcome;
  durationMs: number;
  /** Set when the scenario threw rather than returning a conclusion. */
  error?: string;
}

export interface ScenarioScore {
  scenarioId: string;
  kind: Scenario['kind'];
  measures: Scenario['measures'];
  repeats: number;
  /** Flagged the broken variant — the detection we want. */
  detected: number;
  /** Flagged the correct variant — a false positive, always wrong. */
  falsePositives: number;
  /** Missed the broken variant. */
  missed: number;
  /** Could not conclude, on either variant. Never counted as a success. */
  inconclusive: number;
  /** True when every repeat agreed with every other, per variant. */
  stable: boolean;
  medianDurationMs: number;
}

export interface EvaluationReport {
  tier: EvaluationTier;
  /** Scenarios left out because this tier cannot judge them, and which can. */
  excluded: Array<{ id: string; requiresTier: EvaluationTier }>;
  caveat: string;
  fixtureVersion: string;
  generatedAt: string;
  scenarios: ScenarioScore[];
  totals: {
    scenarios: number;
    /** Scenarios this tier cannot judge, and so did not run. */
    excludedScenarios: number;
    /** Scenarios with a real application defect — the detection denominator. */
    detectionScenarios: number;
    /** Scenarios measuring locator recovery instead of defect detection. */
    healingScenarios: number;
    /** Denominators are reported alongside every count, never a bare rate. */
    brokenRuns: number;
    correctRuns: number;
    detected: number;
    missed: number;
    falsePositives: number;
    inconclusive: number;
    unstableScenarios: number;
    detectionRate?: number;
    falsePositiveRate?: number;
    totalDurationMs: number;
  };
  records: RunRecord[];
  /**
   * Cost and token usage, when the tier incurred any.
   *
   * `undefined` on the deterministic tier because no model was called — which is
   * different from zero, and reported as such.
   */
  usage?: { calls: number; estimatedUsd: number; model: string };
}

/**
 * Bumped whenever a fixture's behaviour changes.
 *
 * A measurement is only comparable to another taken on the same fixtures, so a
 * report that does not name its fixture version cannot be compared to anything.
 */
export const FIXTURE_VERSION = '1.0.0';

/**
 * Builds the driver a scenario runs against.
 *
 * The tier IS the driver — same fixtures, same scenarios, different observer.
 * Injecting it is what makes a cross-tier comparison apples-to-apples: if the
 * real-browser tier reached a different conclusion it would be because it can
 * see layout and trusted input, not because it ran a different test.
 */
export type DriverFactory = (
  variant: 'correct' | 'broken',
  scenario: Scenario
) => Promise<EvaluationDriver>;

/** What a scenario needs from whatever is driving the page. */
export type EvaluationDriver = JsdomDriver;

const jsdomFactory: DriverFactory = async (variant, scenario) =>
  new JsdomDriver({
    resolvePage: (page) => resolve(FIXTURE_ROOT, variant, page),
    respondTo: scenario.respondTo,
    defaultTimeoutMs: 1500,
  });

async function runOnce(
  scenario: Scenario,
  variant: 'correct' | 'broken',
  repeat: number,
  makeDriver: DriverFactory
): Promise<RunRecord> {
  const driver = await makeDriver(variant, scenario);
  const started = Date.now();
  try {
    const outcome = await scenario.run(driver);
    return {
      scenarioId: scenario.id,
      kind: scenario.kind,
      variant,
      repeat,
      outcome,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    // A scenario that throws has not detected anything. Recording it as
    // inconclusive rather than as a detection is what stops a crash from
    // inflating the detection rate.
    return {
      scenarioId: scenario.id,
      kind: scenario.kind,
      variant,
      repeat,
      outcome: { defectFound: false, detail: 'The scenario threw', inconclusive: true },
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await driver.close().catch(() => undefined);
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

function scoreScenario(scenario: Scenario, records: RunRecord[]): ScenarioScore {
  const forVariant = (v: 'correct' | 'broken') => records.filter((r) => r.variant === v);
  const broken = forVariant('broken');
  const correct = forVariant('correct');

  const conclusive = (r: RunRecord) => !r.outcome.inconclusive;
  const detected = broken.filter((r) => conclusive(r) && r.outcome.defectFound).length;
  const missed = broken.filter((r) => conclusive(r) && !r.outcome.defectFound).length;
  const falsePositives = correct.filter((r) => conclusive(r) && r.outcome.defectFound).length;
  const inconclusive = records.filter((r) => r.outcome.inconclusive).length;

  // Stability is per-variant agreement. Mixed outcomes across repeats of the
  // same variant mean the scenario is not deterministic, which has to be visible
  // before any rate computed from it is trusted.
  const agrees = (list: RunRecord[]) =>
    list.length <= 1 || list.every((r) => r.outcome.defectFound === list[0].outcome.defectFound);

  return {
    scenarioId: scenario.id,
    kind: scenario.kind,
    measures: scenario.measures,
    repeats: scenario.repeats ?? 1,
    detected,
    missed,
    falsePositives,
    inconclusive,
    stable: agrees(broken) && agrees(correct),
    medianDurationMs: median(records.map((r) => r.durationMs)),
  };
}

export interface EvaluateOptions {
  tier?: EvaluationTier;
  /** Run a subset, by scenario id. */
  only?: readonly string[];
  scenarios?: readonly Scenario[];
  /** Defaults to the jsdom tier. Supply one to evaluate a different tier. */
  driver?: DriverFactory;
  /**
   * Skip scenarios the chosen tier cannot observe. Defaults to **true**.
   *
   * A blind spot must not be reported as a miss: running a layout-dependent
   * scenario on a DOM without layout produces a failure that says nothing
   * about the product, and folding it into the detection rate makes that rate
   * a worse number than no number. Set false only to demonstrate the blind
   * spot deliberately.
   */
  skipUnsupported?: boolean;
}

/**
 * Run the whole evaluation.
 *
 * Both variants of every scenario, with repeats where the scenario asks for
 * them. Scenarios are never told which variant they are on.
 */
export async function evaluate(opts: EvaluateOptions = {}): Promise<EvaluationReport> {
  const tier = opts.tier ?? 'deterministic-dom';
  const makeDriver = opts.driver ?? jsdomFactory;
  const skipUnsupported = opts.skipUnsupported ?? true;
  const requested = (opts.scenarios ?? SCENARIOS).filter(
    (s) => !opts.only || opts.only.includes(s.id)
  );
  // A scenario the tier cannot observe is EXCLUDED, not run and counted as a
  // miss. Running it would manufacture a false miss out of a known blind spot,
  // which is the opposite of what the report is for.
  const excluded = requested.filter(
    (s) => skipUnsupported && s.requiresTier !== undefined && s.requiresTier !== tier
  );
  const chosen = requested.filter((s) => !excluded.includes(s));

  const records: RunRecord[] = [];
  for (const scenario of chosen) {
    const repeats = scenario.repeats ?? 1;
    for (let repeat = 0; repeat < repeats; repeat++) {
      // Correct first, so a false positive is visible even if the broken run
      // later throws.
      records.push(await runOnce(scenario, 'correct', repeat, makeDriver));
      records.push(await runOnce(scenario, 'broken', repeat, makeDriver));
    }
  }

  const scenarios = chosen.map((s) =>
    scoreScenario(
      s,
      records.filter((r) => r.scenarioId === s.id)
    )
  );

  const brokenRuns = records.filter((r) => r.variant === 'broken').length;
  const correctRuns = records.filter((r) => r.variant === 'correct').length;
  // Detection is scored only over scenarios that HAVE an application defect.
  // A healing scenario's broken variant still passes the test, so folding it in
  // would report a miss that is not one.
  const detectionScenarios = scenarios.filter((s) => s.measures === 'defect-detection');
  const detected = detectionScenarios.reduce((n, s) => n + s.detected, 0);
  const missed = detectionScenarios.reduce((n, s) => n + s.missed, 0);
  // False positives are counted across ALL scenarios: flagging a working
  // application is wrong whatever the scenario was measuring.
  const falsePositives = scenarios.reduce((n, s) => n + s.falsePositives, 0);
  const healingScenarios = scenarios.filter((s) => s.measures === 'healing');

  // A rate with no denominator is meaningless, so both are absent when there is
  // nothing to divide by rather than being reported as zero or one.
  const rate = (numerator: number, denominator: number) =>
    denominator > 0 ? Math.round((numerator / denominator) * 100) : undefined;

  return {
    tier,
    excluded: excluded.map((s) => ({ id: s.id, requiresTier: s.requiresTier! })),
    caveat: TIER_CAVEATS[tier],
    fixtureVersion: FIXTURE_VERSION,
    generatedAt: new Date().toISOString(),
    scenarios,
    totals: {
      scenarios: chosen.length,
      excludedScenarios: excluded.length,
      detectionScenarios: detectionScenarios.length,
      healingScenarios: healingScenarios.length,
      brokenRuns,
      correctRuns,
      detected,
      missed,
      falsePositives,
      inconclusive: scenarios.reduce((n, s) => n + s.inconclusive, 0),
      unstableScenarios: scenarios.filter((s) => !s.stable).length,
      detectionRate: rate(detected, detected + missed),
      falsePositiveRate: rate(falsePositives, correctRuns),
      totalDurationMs: records.reduce((n, r) => n + r.durationMs, 0),
    },
    records,
    // No model was called on this tier. Absent, not zero — those are different
    // claims, and reporting $0.00 implies a model ran and cost nothing.
    usage: undefined,
  };
}

/** The report as text, for a terminal or a CI log. */
export function formatReport(report: EvaluationReport): string {
  const t = report.totals;
  const lines: string[] = [
    `# Pathfinder evaluation — ${report.tier}`,
    '',
    `Fixtures ${report.fixtureVersion} · ${report.generatedAt}`,
    `**Tier caveat:** ${report.caveat}`,
    '',
    '## Totals',
    '',
    '| Measure | Count | Denominator |',
    '|---|---|---|',
    `| Seeded defects detected | ${t.detected} | ${t.detected + t.missed} conclusive runs over ${t.detectionScenarios} defect scenarios |`,
    `| Seeded defects missed | ${t.missed} | ${t.detected + t.missed} conclusive runs over ${t.detectionScenarios} defect scenarios |`,
    `| False positives | ${t.falsePositives} | ${t.correctRuns} correct-variant runs |`,
    `| Inconclusive | ${t.inconclusive} | ${t.brokenRuns + t.correctRuns} total runs |`,
    `| Unstable scenarios | ${t.unstableScenarios} | ${t.scenarios} scenarios |`,
    `| Not judgeable on this tier | ${t.excludedScenarios} | ${t.scenarios + t.excludedScenarios} scenarios defined |`,
    '',
    t.detectionRate !== undefined
      ? `Detection ${t.detectionRate}% · false positives ${t.falsePositiveRate ?? 0}% · ${Math.round(t.totalDurationMs / 100) / 10}s total`
      : 'No conclusive runs — no rate can be reported.',
    '',
    report.usage
      ? `Model usage: ${report.usage.calls} call(s), ~$${report.usage.estimatedUsd.toFixed(4)} on ${report.usage.model}`
      : 'Model usage: none — no model was called on this tier.',
    '',
    ...(report.excluded.length > 0
      ? [
          '## Excluded from this tier',
          '',
          'Not run, because this tier cannot judge them — a blind spot must not be',
          'reported as a missed defect.',
          '',
          ...report.excluded.map((e) => `- \`${e.id}\` — needs the **${e.requiresTier}** tier`),
          '',
        ]
      : []),
    '## Per scenario',
    '',
    '| Scenario | Measures | Repeats | Detected | Missed | False pos. | Stable | Median |',
    '|---|---|---|---|---|---|---|---|',
  ];

  for (const s of report.scenarios) {
    // A healing scenario has no defect to detect; showing 0/0 there would read
    // as a failure rather than as "not applicable".
    const detected = s.measures === 'healing' ? 'n/a' : String(s.detected);
    const missed = s.measures === 'healing' ? 'n/a' : String(s.missed);
    lines.push(
      `| ${s.scenarioId} | ${s.measures} | ${s.repeats} | ${detected} | ${missed} | ` +
        `${s.falsePositives} | ${s.stable ? 'yes' : '**no**'} | ${s.medianDurationMs}ms |`
    );
  }

  const problems = report.records.filter(
    (r) => r.error || (r.variant === 'correct' && r.outcome.defectFound)
  );
  if (problems.length > 0) {
    lines.push('', '## Needs attention', '');
    for (const r of problems) {
      lines.push(
        `- \`${r.scenarioId}\` on **${r.variant}** (repeat ${r.repeat}): ` +
          `${r.error ? `threw — ${r.error}` : `false positive — ${r.outcome.detail}`}`
      );
    }
  }

  return lines.join('\n');
}
