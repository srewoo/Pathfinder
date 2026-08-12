/**
 * Oracles over a state diff (deeper oracles, deterministic tier).
 *
 * These answer questions a "success banner appeared" assertion cannot:
 *
 *   - the app SAID it saved, but told the server nothing
 *   - the server returned an error while the UI claimed success
 *   - a read-only action wrote to the server anyway
 *   - a destructive action was reported as done with nothing removed
 *
 * Zero tokens, fully reproducible (§9). Every oracle here was written
 * false-positive-first: the question asked of each was not "what bug can this
 * find?" but "what correct app would this accuse?" — and where that answer was
 * "plenty", the oracle is either narrowed or graded `low`. Precision is the
 * metric that decides whether any of this gets used (§10).
 */
import type { Finding } from './deterministic-detectors';
import type { StateDiff } from './state-diff';

/** Phrases that indicate the app claimed a state change succeeded. */
const SUCCESS_PATTERNS = [
  /\bsaved\b/i,
  /\bcreated\b/i,
  /\bupdated\b/i,
  /\bdeleted\b/i,
  /\bremoved\b/i,
  /\badded\b/i,
  /\bsent\b/i,
  /\bsubmitted\b/i,
  /\bsuccess(fully)?\b/i,
  /\bcomplete[d]?\b/i,
];

/**
 * Phrases that indicate the app reported a problem.
 *
 * Negated forms matter as much as the obvious keywords: "Could not save" is the
 * single most common failure message in real UIs and matches none of
 * error/failed/invalid. A test caught that omission.
 *
 * Deliberately excludes generic words like "wrong" and "problem" on their own —
 * they appear in ordinary UI copy ("Something wrong? Contact support"), and this
 * predicate both raises findings AND suppresses `success-over-failure`, so
 * over-matching would hide real contradictions.
 */
const ERROR_PATTERNS = [
  /\berror\b/i,
  /\bfailed\b/i,
  /\bfailure\b/i,
  /\binvalid\b/i,
  /\bunable\b/i,
  /\bcannot\b/i,
  /\bcan['’]?t\b/i,
  /\bcould\s?n[o']?t\b/i,
  /\bwas\s+not\s+(saved|created|updated|sent)\b/i,
  /\bdenied\b/i,
  /\brejected\b/i,
  /\bunsuccessful\b/i,
  /\bwent\s+wrong\b/i,
  /\btry\s+again\b/i,
];

export function claimsSuccess(messages: readonly string[]): boolean {
  return messages.some((m) => SUCCESS_PATTERNS.some((p) => p.test(m)));
}

export function claimsError(messages: readonly string[]): boolean {
  return messages.some((m) => ERROR_PATTERNS.some((p) => p.test(m)));
}

export interface OracleContext {
  /** What the action was, for the message. */
  action: string;
  /**
   * True when the action was expected to change server state (a submit, a
   * delete). Drives the "claimed success but wrote nothing" oracle.
   */
  expectedToWrite?: boolean;
  /** True when the run is read-only, so any server write is a violation. */
  readOnly?: boolean;
}

/**
 * The headline oracle: the UI claimed success while the server was never told.
 *
 * This is the bug class that DOM-only assertions structurally cannot see — an
 * optimistic UI that renders success and drops the request. A "success banner is
 * visible" assertion passes; the user's data is gone.
 *
 * Narrowed to avoid the obvious false positive: it only fires when the app made
 * NO request at all. An app that wrote via WebSocket, or batches saves, would
 * otherwise be accused — so a read request counts as evidence of contact and
 * suppresses the finding.
 */
export function detectSuccessWithoutWrite(diff: StateDiff, ctx: OracleContext): Finding[] {
  if (!claimsSuccess(diff.newMessages)) return [];
  if (diff.requests.length > 0) return [];
  // A navigation is itself evidence the action was processed somewhere.
  if (diff.navigated) return [];
  // A client-side-only app legitimately persists to storage rather than a server.
  if (diff.storageChanges.length > 0) return [];

  return [
    {
      kind: 'success-without-persistence',
      severity: 'high',
      message: `"${ctx.action}" reported success but nothing was persisted`,
      evidence:
        `App showed "${diff.newMessages.join(' | ')}" while making zero network requests, ` +
        `writing nothing to local/session storage, and not navigating. ` +
        `Nothing outside the current DOM records this change.`,
    },
  ];
}

/**
 * The server rejected the action and the UI said it worked.
 *
 * High severity and high confidence: two channels directly contradict each other,
 * so this is not a heuristic. A correct app does not show "Saved" over a 500.
 */
export function detectSuccessOverFailure(diff: StateDiff, ctx: OracleContext): Finding[] {
  if (diff.failedRequests.length === 0) return [];
  if (!claimsSuccess(diff.newMessages)) return [];
  if (claimsError(diff.newMessages)) return [];

  const worst = [...diff.failedRequests].sort((a, b) => b.status - a.status)[0];
  return [
    {
      kind: 'success-over-failure',
      severity: 'high',
      message: `"${ctx.action}" showed success while the server returned ${worst.status}`,
      evidence:
        `UI said "${diff.newMessages.join(' | ')}" but ${worst.method} ${worst.url} ` +
        `returned ${worst.status}. The user is told the operation succeeded when it did not.`,
      url: worst.url,
    },
  ];
}

/**
 * A read-only run wrote to the server.
 *
 * Complements §7's method gate rather than duplicating it: the gate BLOCKS the
 * request, this reports that the app attempted it — which is what tells you an
 * exploration is unsafe to run unguarded against production.
 */
export function detectUnexpectedWrite(diff: StateDiff, ctx: OracleContext): Finding[] {
  if (!ctx.readOnly) return [];
  if (diff.mutatingRequests.length === 0) return [];

  return diff.mutatingRequests.map((r) => ({
    kind: 'unexpected-mutation' as const,
    severity: 'medium' as const,
    message: `"${ctx.action}" issued ${r.method} ${stripQuery(r.url)} during a read-only run`,
    evidence: `A read-only action attempted to change server state (${r.method}, status ${r.status}).`,
    url: r.url,
  }));
}

/**
 * An action expected to persist something produced no evidence of it.
 *
 * Requires the caller to declare `expectedToWrite`, because only the caller knows
 * the intent. Without that declaration this would fire on every navigation click.
 */
export function detectMissingPersistence(diff: StateDiff, ctx: OracleContext): Finding[] {
  if (!ctx.expectedToWrite) return [];
  if (diff.mutatingRequests.length > 0) return [];
  if (diff.storageChanges.length > 0) return [];

  return [
    {
      kind: 'missing-persistence',
      severity: 'medium',
      message: `"${ctx.action}" was expected to persist a change but did not`,
      evidence:
        `No mutating request and no storage write were observed. ` +
        `Observed instead: ${diff.requests.length} read request(s), ` +
        `${Object.keys(diff.tagDeltas).length} DOM change(s).`,
    },
  ];
}

/**
 * The app reported an error, whatever else happened.
 *
 * Deliberately included even though it looks trivial: an error surfacing during a
 * step whose assertions all pass is invisible today, and it is often the earliest
 * signal of a real defect.
 */
export function detectSurfacedError(diff: StateDiff, ctx: OracleContext): Finding[] {
  if (!claimsError(diff.newMessages)) return [];

  return [
    {
      kind: 'error-surfaced',
      severity: 'medium',
      message: `"${ctx.action}" surfaced an error message`,
      evidence: `App displayed: ${diff.newMessages.filter((m) => ERROR_PATTERNS.some((p) => p.test(m))).join(' | ')}`,
    },
  ];
}

/**
 * Run every diff oracle.
 *
 * Order is severity-first so the most consequential finding reads first in a
 * report.
 */
export function runStateOracles(diff: StateDiff, ctx: OracleContext): Finding[] {
  return [
    ...detectSuccessOverFailure(diff, ctx),
    ...detectSuccessWithoutWrite(diff, ctx),
    ...detectMissingPersistence(diff, ctx),
    ...detectUnexpectedWrite(diff, ctx),
    ...detectSurfacedError(diff, ctx),
  ];
}

function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split('?')[0];
  }
}
