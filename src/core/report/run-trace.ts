/**
 * Run trace bundle (fix.md §11).
 *
 * Everything needed to diagnose a failure after the fact, in one artifact:
 * results, the heal log, the mutation ledger, the testability report, the network
 * log, and failure screenshots.
 *
 * The reason this is a bundle rather than scattered exports: debugging a failed
 * run means correlating "which locator healed" against "what did the network do"
 * against "what did the page look like". Separate files make that manual.
 */
import type { HealEvent } from './heal-ledger';
import type { TestabilityReport } from './heal-ledger';
import type { LedgerEntry, LedgerSummary } from '../safety/mutation-ledger';
import type { ExportRun } from './junit-export';
import { summarize } from './junit-export';
import type { TestIR } from '../ir/test-ir';
import { serializeIR } from '../ir/test-ir';

export const TRACE_SCHEMA = 'pathfinder.trace/1';

export interface NetworkTraceEntry {
  url: string;
  method: string;
  status: number;
  durationMs?: number;
}

export interface RunTrace {
  schema: typeof TRACE_SCHEMA;
  runId: string;
  createdAt: string;
  run: ExportRun;
  heals: readonly HealEvent[];
  mutations: { summary: LedgerSummary; entries: readonly LedgerEntry[] };
  testability: TestabilityReport;
  network: readonly NetworkTraceEntry[];
  /** Base64 PNGs keyed by `testId:stepOrder`. Capped — see MAX_SCREENSHOTS. */
  screenshots: Record<string, string>;
  /** The exact IR that ran, so a failure can be reproduced verbatim. */
  tests: Record<string, unknown>;
}

/**
 * Screenshots dominate bundle size (~100–500KB each). Capping keeps a trace
 * shareable; failures are prioritised because a screenshot of a passing step is
 * rarely what anyone opens.
 */
export const MAX_SCREENSHOTS = 25;

export interface BuildTraceInput {
  runId: string;
  createdAt: string;
  run: ExportRun;
  heals: readonly HealEvent[];
  mutationSummary: LedgerSummary;
  mutationEntries: readonly LedgerEntry[];
  testability: TestabilityReport;
  network: readonly NetworkTraceEntry[];
  screenshots?: Record<string, string>;
  irs?: readonly TestIR[];
}

export function buildRunTrace(input: BuildTraceInput): RunTrace {
  const failedIds = new Set(
    input.run.results.filter((r) => r.verdict === 'FAIL').map((r) => r.id)
  );

  return {
    schema: TRACE_SCHEMA,
    runId: input.runId,
    createdAt: input.createdAt,
    run: input.run,
    heals: input.heals,
    mutations: { summary: input.mutationSummary, entries: input.mutationEntries },
    testability: input.testability,
    network: input.network,
    screenshots: prioritizeScreenshots(input.screenshots ?? {}, failedIds),
    tests: Object.fromEntries(
      (input.irs ?? []).map((ir) => [ir.id, JSON.parse(serializeIR(ir))])
    ),
  };
}

/**
 * Keep failure screenshots first, then fill remaining slots.
 *
 * Truncation is disclosed via `__truncated` rather than silently applied — a cap
 * that reads as "that was everything" is the reporting equivalent of a silent
 * catch.
 */
export function prioritizeScreenshots(
  screenshots: Record<string, string>,
  failedTestIds: ReadonlySet<string>,
  max = MAX_SCREENSHOTS
): Record<string, string> {
  const keys = Object.keys(screenshots);
  if (keys.length <= max) return { ...screenshots };

  const isFailure = (k: string) => failedTestIds.has(k.split(':')[0]);
  const ordered = [...keys.filter(isFailure), ...keys.filter((k) => !isFailure(k))];
  const kept = ordered.slice(0, max);

  const out: Record<string, string> = {};
  for (const k of kept) out[k] = screenshots[k];
  out.__truncated = `${keys.length - kept.length} further screenshot(s) omitted (cap ${max})`;
  return out;
}

export function serializeTrace(trace: RunTrace): string {
  return JSON.stringify(trace, null, 2);
}

/** Human-readable digest for the side panel and for pasting into a ticket. */
export function formatTraceSummary(trace: RunTrace): string {
  const s = summarize(trace.run);
  const lines = [
    `Run ${trace.runId} — ${s.passed} passed, ${s.needsReview} need review, ${s.failed} failed`,
    `Duration: ${(trace.run.durationMs / 1000).toFixed(1)}s`,
  ];

  if (trace.heals.length > 0) {
    lines.push(
      '',
      `${trace.heals.length} locator heal(s):`,
      ...trace.heals
        .slice(0, 10)
        .map((h) => `  • ${h.target}: ${h.from} → ${h.to} (test ${h.testId}, step ${h.stepOrder})`)
    );
    if (trace.heals.length > 10) lines.push(`  … and ${trace.heals.length - 10} more`);
  }

  const m = trace.mutations.summary;
  if (m.mutationsPermitted > 0) {
    lines.push(
      '',
      `This run CHANGED remote state — ${m.mutationsPermitted} mutating request(s):`,
      ...m.changedEndpoints.slice(0, 10).map((e) => `  • ${e}`)
    );
  } else {
    lines.push('', 'No remote state was changed by this run.');
  }

  if (m.requestsRefused > 0) {
    // Distinguishing "found nothing" from "was blocked 40 times" is the
    // difference between a clean bill of health and a misconfiguration.
    lines.push(
      `${m.requestsRefused} request(s) refused by policy ` +
        `(${m.refusedByOrigin} off-allowlist, ${m.refusedByMethod} blocked verb).`
    );
  }

  lines.push('', `Testability: ${Math.round(trace.testability.score * 100)}% durable locators`);
  if (trace.testability.gaps.length > 0) {
    lines.push(`${trace.testability.gaps.length} element(s) would benefit from a data-testid.`);
  }

  return lines.join('\n');
}
