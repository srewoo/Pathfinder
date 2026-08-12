/**
 * Safety-installation port (fix.md §2, §7).
 *
 * Request interception is a CDP capability, so the implementation lives in
 * `src/drivers/cdp-safety.ts`. Core declares the capability here and calls it at
 * session start, which is what makes enforcement unconditional: it is not an
 * option a caller passes, it is part of opening a session.
 */
import type { OriginPolicy } from './origin-policy';
import type { MutationLedger } from './mutation-ledger';

export interface SafetyHandle {
  dispose(): Promise<void>;
  abortedCount(): number;
  /**
   * Refusals that break the page rather than merely blocking a tracker.
   *
   * Surfaced through the port because the run reporter needs it: a run whose
   * scripts were blocked did not test the app, and must not be reported as
   * though it did.
   */
  criticalBlocks(): readonly string[];
}

export type SafetyInstallerFn = (
  tabId: number,
  policy: OriginPolicy,
  ledger: MutationLedger
) => Promise<SafetyHandle>;

let installer: SafetyInstallerFn | null = null;

export function registerSafetyInstaller(fn: SafetyInstallerFn): void {
  installer = fn;
}

export function clearSafetyInstaller(): void {
  installer = null;
}

export function isSafetyInstallerRegistered(): boolean {
  return installer !== null;
}

/**
 * Install enforcement for a tab.
 *
 * Returns null when no installer is registered. Callers MUST treat null as
 * "unprotected" and say so — a run with no enforcement is a materially different
 * thing from a run that enforced and found nothing, and conflating them is how a
 * safety regression goes unnoticed.
 */
export async function installRunSafety(
  tabId: number,
  policy: OriginPolicy,
  ledger: MutationLedger
): Promise<SafetyHandle | null> {
  if (!installer) return null;
  return installer(tabId, policy, ledger);
}
