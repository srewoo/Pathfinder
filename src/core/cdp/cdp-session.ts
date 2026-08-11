/**
 * CDP session lifecycle (fix.md §3).
 *
 * Replaces `cdp-action-runner.ts`, which used to carry a SECOND implementation
 * of every action alongside `content/dom-actions.ts` and switched between them
 * at run time. That was the dual-path divergence §3 exists to remove: a bug
 * fixed in one path survived in the other, and which path ran depended on
 * whether the debugger happened to be attached.
 *
 * Actions now live in exactly one place — the CDP driver, reached via
 * `drivers/step-runner.ts`. What remains here is session setup and teardown,
 * which is genuinely session-scoped rather than per-action.
 */
import {
  attach,
  detach,
  isAttached,
  enableDialogAutoDismiss,
  registerDialogHandler,
  unregisterDialogHandler,
  startHARCapture,
  stopHARCapture,
  getHAREntries,
  getAccessibilityTree,
  serializeAXTree,
} from './cdp-client';
import type { HAREntry } from './cdp-client';
import { releaseTab } from '../step-executor';
import type { OriginPolicy } from '../safety/origin-policy';
import type { MutationLedger } from '../safety/mutation-ledger';
import { createMutationLedger } from '../safety/mutation-ledger';
import { describePolicy, isPolicyEmpty, resolvePolicy, type PolicyInput } from '../safety/policy-resolver';
import { installRunSafety, isSafetyInstallerRegistered, type SafetyHandle } from '../safety/safety-port';
import { createLogger } from '../../utils/logger';

const log = createLogger('cdp-session');

/**
 * Prepare a tab for execution: attach the debugger, neutralise JS dialogs, and
 * start network capture.
 *
 * Returns false when attachment fails. With the content-script path gone this is
 * no longer a "degrade to synthetic events" signal — it means the tab cannot be
 * driven at all, and the caller must surface that rather than proceed.
 */
export async function initCDPSession(
  tabId: number,
  safety?: PolicyInput
): Promise<boolean> {
  try {
    await attach(tabId);
    await enableDialogAutoDismiss(tabId);
    registerDialogHandler(tabId);
    await startHARCapture(tabId);

    // §7: enforcement is part of opening a session, not an option a caller
    // passes. Installing it here is what makes it unbypassable.
    await installSafetyForRun(tabId, safety);

    log.info(`CDP session initialized for tab ${tabId}`);
    return true;
  } catch (err) {
    log.error(
      `CDP attach failed for tab ${tabId} — this tab cannot be driven ` +
        `(restricted page, or the debugger is already in use)`,
      err
    );
    return false;
  }
}

// ── §7 safety wiring ────────────────────────────────────────────────────────

interface RunSafety {
  policy: OriginPolicy;
  ledger: MutationLedger;
  handle: SafetyHandle | null;
}

const runSafety = new Map<number, RunSafety>();

async function installSafetyForRun(tabId: number, input?: PolicyInput): Promise<void> {
  const policy = resolvePolicy(input ?? {});
  const ledger = createMutationLedger();

  if (isPolicyEmpty(policy)) {
    // Failing closed would abort every request and look like a broken network.
    // Skipping enforcement silently would be worse. So: no interception, and a
    // loud warning naming the cause.
    log.warn(
      `No origin could be resolved for this run — request enforcement is NOT active. ` +
        `Pass a startUrl to scope the run (fix.md §7).`
    );
    runSafety.set(tabId, { policy, ledger, handle: null });
    return;
  }

  if (!isSafetyInstallerRegistered()) {
    log.error(
      'No safety installer registered — this run is UNPROTECTED. ' +
        'The driver layer must import drivers/cdp-safety at startup.'
    );
    runSafety.set(tabId, { policy, ledger, handle: null });
    return;
  }

  const handle = await installRunSafety(tabId, policy, ledger);
  runSafety.set(tabId, { policy, ledger, handle });
  log.info(`Request enforcement active on tab ${tabId}: ${describePolicy(policy)}`);
}

/** The mutation ledger for a run, for the report. Null when never installed. */
export function getRunLedger(tabId: number): MutationLedger | null {
  return runSafety.get(tabId)?.ledger ?? null;
}

/** The resolved policy for a run, for the report. */
export function getRunPolicy(tabId: number): OriginPolicy | null {
  return runSafety.get(tabId)?.policy ?? null;
}

/** True when interception is genuinely active — not merely configured. */
export function isEnforcementActive(tabId: number): boolean {
  return runSafety.get(tabId)?.handle !== null && runSafety.has(tabId);
}

/** Tear down the session and return the captured HAR. Safe to call twice. */
export async function teardownCDPSession(tabId: number): Promise<HAREntry[]> {
  let harEntries: HAREntry[] = [];

  try {
    harEntries = await stopHARCapture(tabId);
  } catch {
    // Non-fatal — capture may never have started.
  }

  unregisterDialogHandler(tabId);

  // Dispose enforcement before detaching — the Fetch listener outlives the
  // session otherwise (CLAUDE.md §11.1: listener accumulation is a leak).
  const safety = runSafety.get(tabId);
  if (safety?.handle) {
    const summary = safety.ledger.summary();
    if (summary.mutationsPermitted > 0 || summary.requestsRefused > 0) {
      log.info(
        `Run changed ${summary.mutationsPermitted} endpoint(s); ` +
          `refused ${summary.requestsRefused} request(s) ` +
          `(${summary.refusedByOrigin} off-allowlist, ${summary.refusedByMethod} blocked verb)`
      );
    }
    await safety.handle.dispose().catch(() => undefined);
  }
  runSafety.delete(tabId);

  // Drop the cached driver so a closed tab does not leak one (CLAUDE.md §11.1).
  releaseTab(tabId);

  try {
    await detach(tabId);
  } catch {
    // Tab may already be closed.
  }

  return harEntries;
}

/** Serialized accessibility tree, for AI planning context. */
export async function getAXContext(tabId: number): Promise<string> {
  if (!isAttached(tabId)) return '';
  try {
    return serializeAXTree(await getAccessibilityTree(tabId));
  } catch (err) {
    log.debug(`AX tree unavailable for tab ${tabId}`, err);
    return '';
  }
}

/** Network entries captured so far in this session. */
export function getCurrentHAR(tabId: number): HAREntry[] {
  return getHAREntries(tabId);
}

export { captureFullPageScreenshot } from './cdp-client';
