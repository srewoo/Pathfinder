/**
 * The low-level primitives exploration is built on: waiting, navigating, and
 * deciding how long a page is allowed to take.
 *
 * Split out of `explorer-agent.ts` unchanged. The agent was 2,100 lines in
 * which the BFS orchestration, the per-page interaction pass and these
 * mechanical helpers all shared one scope, so a reader looking for "how long
 * does a page get" had to read past the crawl loop to find it. Nothing here
 * knows about the graph, the queue, or what is being explored — which is the
 * property that makes it safe to read on its own.
 *
 * Behaviour is byte-for-byte what it was; only the file boundary moved.
 */
import { isAttached, waitForNetworkIdle, waitForDomSettle } from '../cdp/cdp-client';

/**
 * Pause after an exploration action.
 *
 * Was 1000ms. `settle()` already waits for network idle plus DOM quiet, so the
 * flat second was belt-and-braces on top of a real signal — and it was the single
 * largest cost per click. At ~90 interactive elements on a typical app page it
 * alone consumed a minute and a half of the page budget.
 */
export const ACTION_DELAY_MS = 250;

/**
 * Per-page budgets, and how they relate to the target caps.
 *
 * These were flat numbers that silently contradicted the caps. 90s of budget at
 * roughly 2.5s per click bought ~35 clicks against a cap of 100, and exhaustive
 * mode's 300s bought ~120 against a cap of 300 — so on any real app the budget
 * ended exploration long before the cap did, and the cap was decoration. Measured
 * on a live app: 90 interactive elements on an ordinary list page, 205 on a longer
 * one.
 *
 * Now the budget is DERIVED from the work in front of it, so the two cannot
 * disagree: allow `PER_TARGET_BUDGET_MS` per queued target, with a floor so small
 * pages are never rushed and a ceiling so one pathological page cannot own the run.
 *
 * A budget is a CEILING, not a duration — a page with 12 targets finishes in
 * seconds regardless. Raising it costs nothing except on pages that genuinely have
 * hundreds of controls, which are exactly the pages worth the time.
 */
const PER_TARGET_BUDGET_MS = 2_000;
/** Floor for an ordinary page. */
const DEFAULT_PAGE_EXPLORATION_BUDGET_MS = 240_000; // 4 min
/** Ceiling for an ordinary page. */
const MAX_PAGE_EXPLORATION_BUDGET_MS = 480_000; // 8 min
/** Floor for the anchored page when exhaustively covering every element. */
const EXHAUSTIVE_PAGE_BUDGET_MS = 480_000; // 8 min
/** Ceiling for exhaustive mode — 300 targets × 2s, with headroom. */
const MAX_EXHAUSTIVE_PAGE_BUDGET_MS = 900_000; // 15 min
/** Max click targets when exhaustively covering a page. */
export const EXHAUSTIVE_TARGET_CAP = 300;

/**
 * Budget for a page, sized to its actual target count.
 *
 * `targetCount` includes only what is queued up front; clicks that reveal more
 * targets (dropdown items, expanded panels) push against the ceiling, which is
 * why the ceiling is well above floor + caps.
 */
export function budgetForPage(targetCount: number, exhaustive: boolean): number {
  const floor = exhaustive ? EXHAUSTIVE_PAGE_BUDGET_MS : DEFAULT_PAGE_EXPLORATION_BUDGET_MS;
  return Math.min(budgetCeiling(exhaustive), Math.max(floor, targetCount * PER_TARGET_BUDGET_MS));
}

/** Hard upper bound for one page, whatever the measured cost turns out to be. */
export function budgetCeiling(exhaustive: boolean): number {
  return exhaustive ? MAX_EXHAUSTIVE_PAGE_BUDGET_MS : MAX_PAGE_EXPLORATION_BUDGET_MS;
}

/**
 * Re-estimate the budget from what clicks on THIS page actually cost.
 *
 * `PER_TARGET_BUDGET_MS` is a starting guess, and on a heavy SPA it was wrong by
 * almost 6× — a measured run averaged 11.7s per target and ran out with 13 of 54
 * targets untried, while the ceiling still had headroom to spare. Extending the
 * deadline from the observed rate uses that headroom instead of stopping early on
 * the strength of a constant.
 *
 * Only ever extends, never shrinks: a page that started slowly should not have its
 * budget cut when a few fast clicks pull the average down.
 */
export function adaptBudget(
  current: number,
  elapsedMs: number,
  clicksDone: number,
  targetCount: number,
  exhaustive: boolean
): number {
  if (clicksDone < 3) return current; // too few samples to mean anything
  const perTarget = elapsedMs / clicksDone;
  const projected = Math.ceil(perTarget * targetCount * 1.15); // 15% headroom
  return Math.min(budgetCeiling(exhaustive), Math.max(current, projected));
}

/**
 * Compute an adaptive delay based on the page's observed load time.
 * Returns a delay between `baseMs` and 3000ms, scaled by the page load time.
 * Falls back to `baseMs` when no load time is available.
 */
export function getAdaptiveDelay(baseMs: number, pageLoadTimeMs?: number): number {
  if (!pageLoadTimeMs || pageLoadTimeMs <= 0) return baseMs;
  return Math.min(Math.max(baseMs, Math.round(pageLoadTimeMs * 0.3)), 3000);
}

/**
 * Wait for a tab to become stable after a navigation or interaction.
 *
 * Prefers event-driven signals over a fixed sleep: when CDP is attached (the
 * normal case during exploration) it waits for the network to go quiet and the
 * DOM to settle, so fast pages proceed in a few hundred ms and slow SPAs get up
 * to the ceiling. Falls back to an adaptive fixed delay only when CDP is
 * unavailable for the tab.
 */
export async function settle(
  tabId: number,
  opts: { idleMs?: number; timeoutMs?: number; fallbackMs?: number; pageLoadTimeMs?: number } = {},
): Promise<void> {
  const { idleMs = 400, timeoutMs = 8_000, fallbackMs = ACTION_DELAY_MS, pageLoadTimeMs } = opts;
  if (isAttached(tabId)) {
    await waitForNetworkIdle(tabId, { idleMs, timeoutMs });
    await waitForDomSettle(tabId, 2_000);
  } else {
    await delay(getAdaptiveDelay(fallbackMs, pageLoadTimeMs));
  }
}

/**
 * Run an async function with a timeout. Rejects if the function doesn't
 * complete within the specified time.
 */
export function withTimeout<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Exploration click timeout after ${ms}ms`)), ms);
    fn().then(
      (result) => { clearTimeout(timer); resolve(result); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}


export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
