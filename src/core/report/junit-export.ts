/**
 * JUnit XML + JSON result export (fix.md §11).
 *
 * The CLI is gone, so the extension is now the source of shareable output. A CI
 * job consumes these artifacts from the repo instead of running Pathfinder —
 * which is what replaces the CI gating §1 gave up, without maintaining a second
 * engine to produce it.
 *
 * NEEDS_REVIEW (§5) has no JUnit equivalent. It is emitted as a passing testcase
 * carrying a `<system-out>` note rather than a failure: downgrading a real pass
 * to a failure would train teams to ignore the signal, which defeats the point.
 */
import type { TestVerdict } from './heal-ledger';

export interface ExportStep {
  order: number;
  description: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  error?: string;
  healed?: { from: string; to: string };
}

export interface ExportTestResult {
  id: string;
  name: string;
  verdict: TestVerdict;
  durationMs: number;
  startedAt: string;
  steps: ExportStep[];
  errorMessage?: string;
  healedLocatorCount: number;
  tags?: string[];
}

export interface ExportRun {
  runId: string;
  suiteName: string;
  startedAt: string;
  durationMs: number;
  results: ExportTestResult[];
  /** Mutation ledger summary, so a reviewer can see what the run changed. */
  mutations?: { permitted: number; refused: number; changedEndpoints: string[] };
  testability?: { score: number; gapCount: number };
}

// ── JUnit XML ───────────────────────────────────────────────────────────────

export function toJUnitXml(run: ExportRun): string {
  const failures = run.results.filter((r) => r.verdict === 'FAIL').length;
  const reviews = run.results.filter((r) => r.verdict === 'NEEDS_REVIEW').length;

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${attr(run.suiteName)}" tests="${run.results.length}" ` +
      `failures="${failures}" time="${seconds(run.durationMs)}">`,
    `  <testsuite name="${attr(run.suiteName)}" tests="${run.results.length}" ` +
      `failures="${failures}" time="${seconds(run.durationMs)}" ` +
      `timestamp="${attr(run.startedAt)}">`,
  ];

  // Run-level context as suite properties — a reviewer reading only the XML
  // still learns whether the run mutated anything.
  lines.push('    <properties>');
  lines.push(`      <property name="pathfinder.runId" value="${attr(run.runId)}"/>`);
  lines.push(`      <property name="pathfinder.needsReview" value="${reviews}"/>`);
  if (run.mutations) {
    lines.push(
      `      <property name="pathfinder.mutationsPermitted" value="${run.mutations.permitted}"/>`,
      `      <property name="pathfinder.requestsRefused" value="${run.mutations.refused}"/>`
    );
  }
  if (run.testability) {
    lines.push(
      `      <property name="pathfinder.testabilityScore" value="${run.testability.score.toFixed(2)}"/>`,
      `      <property name="pathfinder.testabilityGaps" value="${run.testability.gapCount}"/>`
    );
  }
  lines.push('    </properties>');

  for (const result of run.results) {
    lines.push(
      `    <testcase name="${attr(result.name)}" classname="${attr(result.id)}" ` +
        `time="${seconds(result.durationMs)}">`
    );

    if (result.verdict === 'FAIL') {
      const failed = result.steps.find((s) => s.status === 'failed');
      const message = result.errorMessage ?? failed?.error ?? 'Test failed';
      lines.push(
        `      <failure message="${attr(message)}" type="AssertionError">${cdata(
          stepTrace(result)
        )}</failure>`
      );
    } else if (result.verdict === 'NEEDS_REVIEW') {
      lines.push(
        `      <system-out>${cdata(
          `NEEDS_REVIEW: passed, but ${result.healedLocatorCount} locator(s) were healed. ` +
            `This test may no longer exercise what it was written for.\n\n${stepTrace(result)}`
        )}</system-out>`
      );
    }

    lines.push('    </testcase>');
  }

  lines.push('  </testsuite>', '</testsuites>');
  return lines.join('\n');
}

function stepTrace(result: ExportTestResult): string {
  return result.steps
    .map((s) => {
      const mark = s.status === 'passed' ? '✓' : s.status === 'failed' ? '✗' : '–';
      const heal = s.healed ? ` [healed ${s.healed.from}→${s.healed.to}]` : '';
      const err = s.error ? `\n      ${s.error}` : '';
      return `  ${mark} ${s.order}. ${s.description} (${s.durationMs}ms)${heal}${err}`;
    })
    .join('\n');
}

// ── JSON ────────────────────────────────────────────────────────────────────

/**
 * Machine-readable results. Stable key order so committed artifacts diff
 * cleanly, same rationale as the IR's canonical form.
 */
export function toResultJson(run: ExportRun): string {
  return JSON.stringify(
    {
      schema: 'pathfinder.run/1',
      runId: run.runId,
      suiteName: run.suiteName,
      startedAt: run.startedAt,
      durationMs: run.durationMs,
      summary: summarize(run),
      mutations: run.mutations,
      testability: run.testability,
      results: run.results.map((r) => ({
        id: r.id,
        name: r.name,
        verdict: r.verdict,
        durationMs: r.durationMs,
        startedAt: r.startedAt,
        healedLocatorCount: r.healedLocatorCount,
        errorMessage: r.errorMessage,
        tags: r.tags ? [...r.tags].sort() : [],
        steps: r.steps.map((s) => ({
          order: s.order,
          description: s.description,
          status: s.status,
          durationMs: s.durationMs,
          error: s.error,
          healed: s.healed,
        })),
      })),
    },
    null,
    2
  );
}

export interface RunSummary {
  total: number;
  passed: number;
  needsReview: number;
  failed: number;
  /** True when nothing failed. NEEDS_REVIEW does not block. */
  green: boolean;
}

export function summarize(run: ExportRun): RunSummary {
  const passed = run.results.filter((r) => r.verdict === 'PASS').length;
  const needsReview = run.results.filter((r) => r.verdict === 'NEEDS_REVIEW').length;
  const failed = run.results.filter((r) => r.verdict === 'FAIL').length;
  return { total: run.results.length, passed, needsReview, failed, green: failed === 0 };
}

// ── Escaping ────────────────────────────────────────────────────────────────

/**
 * XML attribute escaping. Test names routinely contain quotes and ampersands
 * ("User can't submit & save"), and an unescaped one produces XML that CI
 * silently refuses to parse — the failure looks like "no tests ran".
 */
export function attr(value: string): string {
  return stripIllegalXmlChars(
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
  );
}

/** CDATA wrapper, splitting any `]]>` that would close the section early. */
export function cdata(value: string): string {
  const safe = stripIllegalXmlChars(value.replace(/]]>/g, ']]]]><![CDATA[>'));
  return `<![CDATA[${safe}]]>`;
}

/**
 * Remove characters XML 1.0 forbids outright.
 *
 * Escaping does not help here — &#x1; is just as illegal as a raw 0x01 — so they
 * have to be dropped. One leaking through makes CI report "no tests ran" rather
 * than a parse error, which is a genuinely misleading failure.
 *
 * Written as a codepoint filter rather than a character class: a regex full of
 * literal control characters is unreadable and does not survive copy/paste.
 */
export function stripIllegalXmlChars(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    const legal =
      code === 0x09 || // tab
      code === 0x0a || // line feed
      code === 0x0d || // carriage return
      (code >= 0x20 && code <= 0xd7ff) ||
      (code >= 0xe000 && code <= 0xfffd) ||
      code >= 0x10000;
    if (legal) out += ch;
  }
  return out;
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}
