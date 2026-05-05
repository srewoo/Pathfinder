import type { TestResult } from './types.js';

/**
 * Emit GitHub Actions workflow commands for failing tests so they show up
 * inline in the Checks UI. Reference:
 * https://docs.github.com/en/actions/learn-github-actions/workflow-commands-for-github-actions
 *
 * Also writes a Markdown summary to $GITHUB_STEP_SUMMARY when present.
 */
export function emitGithubAnnotations(results: TestResult[]): string[] {
  const lines: string[] = [];
  for (const r of results) {
    if (r.status === 'passed') continue;
    const title = escape(`pathfinder: ${r.testCaseTitle}`);
    const message = escape(r.errorMessage ?? `${r.status} after ${r.duration}ms`);
    // No source file/line information available from the runner; use group + error.
    lines.push(`::error title=${title}::${message}`);
  }
  return lines;
}

export function buildJobSummary(results: TestResult[]): string {
  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const errored = results.filter((r) => r.status === 'error').length;
  const total = results.length;
  const totalDurationSec = (
    results.reduce((sum, r) => sum + r.duration, 0) / 1000
  ).toFixed(1);

  const rows = results.map((r) => {
    const icon = r.status === 'passed' ? '✅' : r.status === 'failed' ? '❌' : '⚠️';
    const dur = (r.duration / 1000).toFixed(1);
    const err = r.errorMessage ? ` — ${truncate(r.errorMessage, 120)}` : '';
    return `| ${icon} | ${escapeMd(r.testCaseTitle)} | ${dur}s |${err} |`;
  });

  return [
    '# Pathfinder Test Run',
    '',
    `**${passed}** passed · **${failed}** failed · **${errored}** errored — total ${total} (${totalDurationSec}s)`,
    '',
    '|   | Test | Duration | Error |',
    '|---|------|---------:|-------|',
    ...rows,
    '',
  ].join('\n');
}

function escape(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeMd(s: string): string {
  return s.replace(/\|/g, '\\|');
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
