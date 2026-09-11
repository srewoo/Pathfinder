/**
 * The real-browser tier, run as a test so it typechecks and reports like the
 * rest of the harness.
 *
 * Separate config (`vitest.browser.config.ts`) and a separate command, because
 * it needs a display: a persistent context is the only way to load an unpacked
 * MV3 extension, and headless Chrome does not start MV3 service workers.
 *
 * Every prerequisite failure is reported and FAILS — a tier that cannot run
 * must never report success, which is the whole failure mode this harness
 * exists to catch.
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { evaluateInBrowser } from './browser-tier';
import { formatReport } from './harness';

const DIST = resolve(__dirname, '../../dist');

/**
 * The suite is run ONCE and shared.
 *
 * Each call launches Chrome, serves both variants and runs every scenario with
 * its repeats — around forty page journeys. Calling it per test doubled that
 * for no extra information, and made the tier slow enough that nobody would
 * run it.
 */
let runOnce: ReturnType<typeof evaluateInBrowser> | undefined;
function browserRun() {
  runOnce ??= evaluateInBrowser(DIST);
  return runOnce;
}

describe('real-browser tier', () => {
  it('given_the_built_extension_then_the_suite_runs_in_chrome_and_reports', async () => {
    expect(
      existsSync(resolve(DIST, 'manifest.json')),
      'dist/manifest.json is missing — run `npm run build` first'
    ).toBe(true);

    const { report, extensionId } = await browserRun();

    // eslint-disable-next-line no-console
    console.log(
      '\n' + formatReport(report) +
        `\n\nExtension service worker: ${extensionId ?? 'not detected'}\n`
    );

    expect(report.tier).toBe('real-browser');
    // The caveat travels with the numbers on every tier.
    expect(report.caveat).toMatch(/layout|trusted input/i);

    // The gate that is never relaxed, on this tier too.
    const falsePositives = report.records.filter(
      (r) => r.variant === 'correct' && !r.outcome.inconclusive && r.outcome.defectFound
    );
    expect(
      falsePositives.map((f) => `${f.scenarioId}: ${f.outcome.detail}`),
      'a scenario flagged the working application in a real browser'
    ).toEqual([]);

    const crashed = report.records.filter((r) => r.error);
    expect(crashed.map((r) => `${r.scenarioId} (${r.variant}): ${r.error}`)).toEqual([]);
  }, 300_000);

  // The thing only this tier can do. On the deterministic tier this scenario is
  // excluded as unjudgeable; here it must actually be judged.
  it('given_the_css_hidden_scenario_then_this_tier_judges_it_correctly', async () => {
    const { report } = await browserRun();
    const scenario = report.scenarios.find((s) => s.scenarioId === 'css-hidden-confirmation');

    expect(scenario, 'the layout-only scenario should run on this tier').toBeDefined();
    expect(scenario!.detected).toBe(scenario!.repeats);
    expect(scenario!.falsePositives).toBe(0);
  }, 300_000);
});
