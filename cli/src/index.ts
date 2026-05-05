#!/usr/bin/env node
import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { program } from 'commander';
import { launchBrowser, executeTestWithPlaywright, type BrowserName } from './playwright-runner.js';
import { generateHtmlReport, generateJUnitXml } from './html-reporter.js';
import { emitGithubAnnotations, buildJobSummary } from './github-reporter.js';
import { loadConfig, mergeOptions, applyShard, type ReporterName } from './config.js';
import type { ExportedPlans, TestResult } from './types.js';

// ---------------------------------------------------------------------------
// Concurrency pool
// ---------------------------------------------------------------------------

async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const idx = nextIndex++;
      results[idx] = await tasks[idx]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Console helpers
// ---------------------------------------------------------------------------

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function log(msg: string): void {
  process.stdout.write(msg + '\n');
}

// ---------------------------------------------------------------------------
// CLI definition
// ---------------------------------------------------------------------------

program
  .name('pathfinder')
  .description('pathfinder headless test runner — executes exported test plans with Playwright')
  .version('1.0.0');

program
  .command('run')
  .description('Run an exported pathfinder test plan')
  .option('--config <file>', 'Path to pathfinder.config.{ts,js,mjs,json}')
  .option('--plans <file>', 'Path to the exported plans JSON file')
  .option('--browser <name>', 'Browser: chromium, firefox, webkit')
  .option('--headless', 'Run browser in headless mode')
  .option('--no-headless', 'Run browser in headed mode')
  .option('--concurrency <n>', 'Number of tests to run in parallel')
  .option('--output-dir <dir>', 'Directory to write reports to')
  .option('--base-url <url>', 'Base URL when testCase.startUrl is missing')
  .option('--reporter <list>', 'Comma-separated reporters: html,junit,json,github,console')
  .option('--shard <n/m>', 'Shard tests deterministically, e.g. 1/4 runs the first quarter')
  .option('--retries <n>', 'Retry failing tests up to N times (serial)')
  .action(async (cliOpts: Record<string, unknown>) => {
    const runStart = Date.now();

    let opts;
    try {
      const { config } = await loadConfig(cliOpts.config as string | undefined);
      opts = mergeOptions(config, cliOpts as never);
    } catch (err) {
      log(`${RED}Config error: ${err instanceof Error ? err.message : String(err)}${RESET}`);
      process.exit(2);
    }

    // ------------------------------------------------------------------
    // 1. Load plans file
    // ------------------------------------------------------------------
    const plansPath = resolve(opts.plans);
    let exported: ExportedPlans;

    try {
      const raw = readFileSync(plansPath, 'utf-8');
      exported = JSON.parse(raw) as ExportedPlans;
    } catch (err) {
      log(`${RED}Error: Could not load plans file at "${plansPath}": ${err instanceof Error ? err.message : String(err)}${RESET}`);
      process.exit(1);
    }

    const allCases = exported.testCases ?? [];
    const resolvedBaseUrl = opts.baseUrl ?? exported.baseUrl;

    if (allCases.length === 0) {
      log(`${YELLOW}No test cases found in plans file.${RESET}`);
      process.exit(0);
    }

    const testCases = applyShard(allCases, opts.shard);

    if (testCases.length === 0) {
      log(`${YELLOW}Shard ${opts.shard?.current}/${opts.shard?.total} matched no tests.${RESET}`);
      process.exit(0);
    }

    log('');
    log(`${DIM}pathfinder Test Runner${RESET}`);
    log(`${DIM}Plans: ${plansPath}${RESET}`);
    log(
      `${DIM}Tests: ${testCases.length}/${allCases.length}` +
      `  Browser: ${opts.browser}` +
      `  Headless: ${opts.headless}` +
      `  Concurrency: ${opts.concurrency}` +
      (opts.shard ? `  Shard: ${opts.shard.current}/${opts.shard.total}` : '') +
      (opts.retries ? `  Retries: ${opts.retries}` : '') +
      `${RESET}`,
    );
    if (resolvedBaseUrl) log(`${DIM}Base URL: ${resolvedBaseUrl}${RESET}`);
    log(`${DIM}Reporters: ${opts.reporters.join(', ')}${RESET}`);
    log('');

    // ------------------------------------------------------------------
    // 2. Launch browser + run tests
    // ------------------------------------------------------------------
    const browser = await launchBrowser({
      browser: opts.browser as BrowserName,
      headless: opts.headless,
      baseUrl: resolvedBaseUrl,
    });

    const showConsole = opts.reporters.includes('console');

    const tasks = testCases.map((tc) => async (): Promise<TestResult> => {
      const steps = exported.plans[tc.id] ?? [];
      if (showConsole) log(`  ▶ Running: ${tc.title}${DIM} (${steps.length} steps)${RESET}`);

      let result = await executeTestWithPlaywright(tc, steps, browser, {
        browser: opts.browser as BrowserName,
        headless: opts.headless,
        baseUrl: resolvedBaseUrl,
      });

      // Retries — only on failed/error, not skipped
      let attempt = 0;
      while (
        opts.retries > 0 &&
        attempt < opts.retries &&
        (result.status === 'failed' || result.status === 'error')
      ) {
        attempt++;
        if (showConsole) log(`  ${YELLOW}↻ Retry ${attempt}/${opts.retries}: ${tc.title}${RESET}`);
        result = await executeTestWithPlaywright(tc, steps, browser, {
          browser: opts.browser as BrowserName,
          headless: opts.headless,
          baseUrl: resolvedBaseUrl,
        });
      }

      if (showConsole) {
        const durationSec = (result.duration / 1000).toFixed(1);
        if (result.status === 'passed') {
          log(`  ${GREEN}✓ PASSED: ${tc.title} (${durationSec}s)${RESET}`);
        } else if (result.status === 'failed') {
          log(`  ${RED}✗ FAILED: ${tc.title}${result.errorMessage ? ` - ${result.errorMessage}` : ''}${RESET}`);
        } else {
          log(`  ${YELLOW}⚠ ERROR: ${tc.title}${result.errorMessage ? ` - ${result.errorMessage}` : ''}${RESET}`);
        }
      }
      return result;
    });

    let results: TestResult[];
    try {
      results = await runWithConcurrency(tasks, opts.concurrency);
    } finally {
      await browser.close();
    }

    // ------------------------------------------------------------------
    // 3. Write reports
    // ------------------------------------------------------------------
    const outputDir = resolve(opts.outputDir);
    mkdirSync(outputDir, { recursive: true });

    const written: string[] = [];
    if (opts.reporters.includes('html')) {
      const p = resolve(outputDir, shardName('report', opts.shard, 'html'));
      writeFileSync(p, generateHtmlReport(results), 'utf-8');
      written.push(p);
    }
    if (opts.reporters.includes('junit')) {
      const p = resolve(outputDir, shardName('junit', opts.shard, 'xml'));
      writeFileSync(p, generateJUnitXml(results), 'utf-8');
      written.push(p);
    }
    if (opts.reporters.includes('json')) {
      const p = resolve(outputDir, shardName('results', opts.shard, 'json'));
      writeFileSync(p, JSON.stringify(results, null, 2), 'utf-8');
      written.push(p);
    }

    if (opts.reporters.includes('github')) {
      for (const line of emitGithubAnnotations(results)) log(line);
      const summaryPath = process.env.GITHUB_STEP_SUMMARY;
      if (summaryPath) {
        try {
          appendFileSync(summaryPath, buildJobSummary(results) + '\n', 'utf-8');
        } catch (err) {
          log(`${YELLOW}Could not write GITHUB_STEP_SUMMARY: ${err instanceof Error ? err.message : String(err)}${RESET}`);
        }
      }
    }

    // ------------------------------------------------------------------
    // 4. Summary
    // ------------------------------------------------------------------
    const passed = results.filter((r) => r.status === 'passed').length;
    const failed = results.filter((r) => r.status === 'failed').length;
    const errored = results.filter((r) => r.status === 'error').length;
    const totalSec = ((Date.now() - runStart) / 1000).toFixed(1);

    if (showConsole) {
      log('');
      log('─'.repeat(56));
      log(
        `  ${GREEN}✓ ${passed} passed${RESET}  ` +
          `${failed > 0 ? RED : DIM}✗ ${failed} failed${RESET}  ` +
          `${errored > 0 ? YELLOW : DIM}⚠ ${errored} error${RESET}  ` +
          `${DIM}(${totalSec}s)${RESET}`,
      );
      log('─'.repeat(56));
      if (written.length > 0) {
        log('');
        log(`${DIM}Reports:${RESET}`);
        for (const p of written) log(`${DIM}  • ${p}${RESET}`);
      }
      log('');
    }

    if (failed > 0 || errored > 0) process.exit(1);
    process.exit(0);
  });

function shardName(base: string, shard: { current: number; total: number } | undefined, ext: string): string {
  if (!shard) return `${base}.${ext}`;
  return `${base}.shard-${shard.current}-of-${shard.total}.${ext}`;
}

program.parseAsync(process.argv).catch((err: unknown) => {
  log(`${RED}Fatal error: ${err instanceof Error ? err.message : String(err)}${RESET}`);
  process.exit(1);
});
