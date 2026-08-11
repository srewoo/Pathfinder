/**
 * Step-execution port (fix.md §2, §3).
 *
 * `src/core` must not import a concrete driver — that is the §2 boundary, and
 * migrating the legacy call sites in §3 would otherwise have introduced fresh
 * violations of it (core reaching into `src/drivers/step-runner`).
 *
 * So core depends on this port instead. `src/drivers/step-runner.ts` registers
 * the real implementation at startup; tests register a fake. The dependency
 * points from drivers → core, never the reverse.
 *
 * A registry rather than a parameter is a deliberate, bounded compromise:
 * threading a driver through the explorer's call sites means reshaping a
 * 1392-line orchestrator, which §4 sequences separately. When that decomposition
 * lands, each step handler receives its driver explicitly and this registry
 * disappears. Until then it keeps the boundary enforceable by lint.
 */
import type { ExecutionStep } from '../storage/schemas';

export interface StepOutcome {
  success: boolean;
  error?: string;
}

/** Executes one legacy step against a tab. Never throws. */
export type StepExecutorFn = (step: ExecutionStep, tabId: number) => Promise<StepOutcome>;

/** Reports whether a tab can be driven at all. */
export type CanExecuteFn = (tabId: number) => boolean;

/** Releases any per-tab resources the driver layer is holding. */
export type ReleaseTabFn = (tabId: number) => void;

let executor: StepExecutorFn | null = null;
let canExecuteImpl: CanExecuteFn | null = null;
let releaseImpl: ReleaseTabFn | null = null;

/**
 * Install the execution implementation. Called once at startup by the driver
 * layer, and by tests with a fake.
 */
export function registerStepExecutor(
  fn: StepExecutorFn,
  canExec: CanExecuteFn,
  release: ReleaseTabFn
): void {
  executor = fn;
  canExecuteImpl = canExec;
  releaseImpl = release;
}

/** Test/teardown helper — restores the unregistered state. */
export function clearStepExecutor(): void {
  executor = null;
  canExecuteImpl = null;
  releaseImpl = null;
}

/**
 * Drop per-tab driver resources at session teardown.
 *
 * A no-op when nothing is registered — cleanup must never be the thing that
 * throws while tearing a session down (CLAUDE.md §11.1: unclosed handles are a
 * leak, but a throwing cleanup path is worse).
 */
export function releaseTab(tabId: number): void {
  releaseImpl?.(tabId);
}

export function isStepExecutorRegistered(): boolean {
  return executor !== null;
}

/**
 * Execute a step through the registered implementation.
 *
 * An unregistered executor returns a failure rather than throwing: the calling
 * convention across all migrated sites is `{ success, error }`, and a missing
 * registration is a wiring bug that should surface as a clear failed step, not
 * an exception unwinding a crawl.
 */
export async function executeStep(step: ExecutionStep, tabId: number): Promise<StepOutcome> {
  if (!executor) {
    return {
      success: false,
      error:
        'No step executor registered. The driver layer must call ' +
        'registerStepExecutor() at startup (see drivers/step-runner.ts).',
    };
  }
  return executor(step, tabId);
}

/** Whether the tab is drivable. Unregistered counts as "no". */
export function canExecuteStep(tabId: number): boolean {
  return canExecuteImpl ? canExecuteImpl(tabId) : false;
}
