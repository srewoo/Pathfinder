/**
 * TestRail ⇄ Pathfinder mapping.
 *
 * Closing the loop is what makes Pathfinder adoptable by a QA organisation that
 * lives in TestRail rather than in the side panel: pull a run's cases in,
 * execute them, push status, timing, the failure message and the failure
 * screenshot back.
 *
 * Transport failures are collected, never thrown: one unmappable case must not
 * abandon the other forty-nine results of a run. A partially-pushed run that
 * reports exactly what did not land is recoverable; one that throws halfway is
 * not.
 */
import type { Settings, TestCase, TestResult } from '../../storage/schemas';
import {
  TESTRAIL_STATUS,
  type TestRailConfig,
  type TestRailTest,
  type createTestRailClient,
} from './testrail-client';
import { createLogger } from '../../utils/logger';
import { verdictWithReason } from '../report/result-adapter';

const log = createLogger('testrail-sync');

export type TestRailClient = ReturnType<typeof createTestRailClient>;

export interface PushSummary {
  pushed: number;
  attached: number;
  failures: Array<{ caseId: number; error: string }>;
}

export interface PushArgs {
  runId: number;
  results: readonly TestResult[];
  client: TestRailClient;
  /** Maps a Pathfinder result back to its TestRail case. Undefined = unmapped. */
  caseIdFor: (result: TestResult) => number | undefined;
}

/**
 * Pathfinder status → TestRail status id.
 *
 * `error` maps to `failed`: from TestRail's point of view a test that could not
 * run is not a pass, and inventing a custom status would break every instance
 * that has not defined one. `running` maps to `retest` — the honest description
 * of a result captured mid-flight.
 */
export function statusIdFor(status: TestResult['status']): number {
  switch (status) {
    case 'passed':
      return TESTRAIL_STATUS.passed;
    case 'failed':
      return TESTRAIL_STATUS.failed;
    case 'error':
      return TESTRAIL_STATUS.failed;
    default:
      return TESTRAIL_STATUS.retest;
  }
}

/**
 * TestRail status for a result, by verdict rather than raw status.
 *
 * TestRail has no "needs review", and the conservative mapping is `retest` —
 * the one default status that means "somebody look at this again". Pushing it as
 * `passed` is the failure this exists to prevent: a review-required result would
 * land in a shared instance as a clean pass, and the whole point of the verdict
 * is that it must never silently become one.
 *
 * Custom statuses are not used: ids from 6 upward are per-instance, so anything
 * above 5 would be wrong on any instance that has not defined it.
 */
export function statusIdForResult(result: TestResult): number {
  const { verdict } = verdictWithReason(result);
  if (verdict === 'FAIL') return TESTRAIL_STATUS.failed;
  if (verdict === 'NEEDS_REVIEW') return TESTRAIL_STATUS.retest;
  return TESTRAIL_STATUS.passed;
}

/** TestRail's duration format. Returns undefined below 1s — it rejects '0s'. */
export function formatElapsed(ms: number | undefined): string | undefined {
  const totalSeconds = Math.round((ms ?? 0) / 1000);
  if (totalSeconds < 1) return undefined;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

/** Stable id so re-importing the same run updates rather than duplicates. */
function importedId(runId: number, caseId: number): string {
  return `testrail-${runId}-${caseId}`;
}

export function importRunAsTestCases(
  tests: readonly TestRailTest[],
  runId: number
): TestCase[] {
  return tests.map((test) => ({
    id: importedId(runId, test.caseId),
    title: test.title,
    description: `Imported from TestRail run ${runId} (case C${test.caseId})`,
    type: 'positive' as const,
    source: 'user' as const,
    // Absent rather than empty: absent means "needs expansion", which is what
    // the one-line runner acts on. An empty array reads as "a test with zero
    // steps", which would execute nothing and pass.
    steps: test.steps.length > 0 ? test.steps : undefined,
    status: 'pending' as const,
    createdAt: new Date().toISOString(),
  }));
}

function commentFor(result: TestResult): string {
  const { verdict, reason } = verdictWithReason(result);
  // The verdict leads, because it is what the status id was derived from. A
  // reader seeing `retest` needs to know it was a review verdict, not a
  // mid-flight capture.
  const lines = [`Pathfinder: ${verdict} (execution status: ${result.status})`, '', reason];
  if (result.errorMessage) lines.push('', result.errorMessage);
  const healed = (result.steps ?? []).filter((s) => s.healingAttempt?.success).length;
  if (healed > 0) {
    lines.push('', `${healed} selector(s) self-healed during this run.`);
  }
  return lines.join('\n');
}

/** Base64 PNG → Blob for multipart upload. */
function pngBlob(base64: string): Blob {
  const raw = base64.replace(/^data:image\/[a-z+]+;base64,/i, '');
  const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: 'image/png' });
}

/**
 * The screenshot worth attaching, if any.
 *
 * Only failures carry one: attaching a screenshot to every pass would bloat the
 * TestRail instance for no diagnostic value.
 */
function failureScreenshot(result: TestResult): string | undefined {
  if (result.status === 'passed') return undefined;
  if (result.screenshot) return result.screenshot;
  return (result.steps ?? []).find((s) => s.status === 'failed' && s.screenshot)?.screenshot;
}

export async function pushResultsToTestRail(args: PushArgs): Promise<PushSummary> {
  const summary: PushSummary = { pushed: 0, attached: 0, failures: [] };

  for (const result of args.results) {
    const caseId = args.caseIdFor(result);
    if (caseId === undefined) {
      summary.failures.push({
        caseId: 0,
        error: `"${result.testCaseTitle}" has no TestRail case mapping — import it from a run first.`,
      });
      continue;
    }

    let resultId: number;
    try {
      const posted = await args.client.addResultForCase(args.runId, caseId, {
        status_id: statusIdForResult(result),
        comment: commentFor(result),
        elapsed: formatElapsed(result.duration),
      });
      resultId = posted.id;
      summary.pushed++;
    } catch (err) {
      summary.failures.push({ caseId, error: err instanceof Error ? err.message : String(err) });
      continue;
    }

    const screenshot = failureScreenshot(result);
    if (!screenshot || resultId === 0) continue;
    try {
      await args.client.addAttachmentToResult(resultId, pngBlob(screenshot), `failure-C${caseId}.png`);
      summary.attached++;
    } catch (err) {
      // The result landed; only the evidence did not. Report it, do not retract
      // the push — a status in TestRail without its screenshot still beats no
      // status at all.
      log.warn(`Attachment failed for case ${caseId}`, err);
      summary.failures.push({
        caseId,
        error: `Result posted but the screenshot did not attach: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
  }

  return summary;
}

/** A config only when all three fields are present — a partial one fails at 401. */
export function testRailConfigFrom(settings: Settings): TestRailConfig | undefined {
  const tr = settings.testrail;
  if (!tr?.host || !tr.email || !tr.apiKey) return undefined;
  return { host: tr.host, email: tr.email, apiKey: tr.apiKey };
}

/** Recover the TestRail case id from an imported test case id. */
export function caseIdFromTestCaseId(id: string): number | undefined {
  const match = /^testrail-\d+-(\d+)$/.exec(id);
  if (!match) return undefined;
  return Number(match[1]);
}
