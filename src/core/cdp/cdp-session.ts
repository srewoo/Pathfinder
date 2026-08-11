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
export async function initCDPSession(tabId: number): Promise<boolean> {
  try {
    await attach(tabId);
    await enableDialogAutoDismiss(tabId);
    registerDialogHandler(tabId);
    await startHARCapture(tabId);
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

/** Tear down the session and return the captured HAR. Safe to call twice. */
export async function teardownCDPSession(tabId: number): Promise<HAREntry[]> {
  let harEntries: HAREntry[] = [];

  try {
    harEntries = await stopHARCapture(tabId);
  } catch {
    // Non-fatal — capture may never have started.
  }

  unregisterDialogHandler(tabId);
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
