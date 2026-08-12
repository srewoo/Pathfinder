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
import type { Driver } from './driver';

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

/** Runs a page script in a tab. Supplied by the driver layer. */
export type EvaluateInTabFn = <T>(tabId: number, expression: string) => Promise<T>;

/**
 * The `Driver` bound to a tab.
 *
 * Returning `Driver` — a type core OWNS — is what keeps this a port rather than a
 * leak: core depends on the interface it defined, and the driver layer supplies an
 * implementation. State capture and the IR executor both need the full surface, not
 * just `evaluate`.
 */
export type DriverForTabFn = (tabId: number) => Driver;

let executor: StepExecutorFn | null = null;
let canExecuteImpl: CanExecuteFn | null = null;
let releaseImpl: ReleaseTabFn | null = null;
let evaluateImpl: EvaluateInTabFn | null = null;
let driverImpl: DriverForTabFn | null = null;

/**
 * Install the execution implementation. Called once at startup by the driver
 * layer, and by tests with a fake.
 */
export function registerStepExecutor(
  fn: StepExecutorFn,
  canExec: CanExecuteFn,
  release: ReleaseTabFn,
  evaluate: EvaluateInTabFn,
  driverFor: DriverForTabFn
): void {
  executor = fn;
  canExecuteImpl = canExec;
  releaseImpl = release;
  evaluateImpl = evaluate;
  driverImpl = driverFor;
}

/**
 * The Driver for a tab.
 *
 * Throws when unregistered rather than returning a stub: a no-op driver would make
 * oracles observe nothing and report silence as "all clear".
 */
export function driverForTab(tabId: number): Driver {
  if (!driverImpl) {
    throw new Error('No driver registered — the driver layer must call registerStepExecutor().');
  }
  return driverImpl(tabId);
}

/**
 * Run a page script in a tab.
 *
 * Throws when unregistered rather than returning undefined: a silent no-op here
 * would make state isolation appear to succeed while clearing nothing.
 */
export function evaluateInTab<T>(tabId: number, expression: string): Promise<T> {
  if (!evaluateImpl) {
    return Promise.reject(
      new Error('No page evaluator registered — the driver layer must call registerStepExecutor().')
    );
  }
  return evaluateImpl<T>(tabId, expression);
}

/** Test/teardown helper — restores the unregistered state. */
export function clearStepExecutor(): void {
  executor = null;
  canExecuteImpl = null;
  releaseImpl = null;
  evaluateImpl = null;
  driverImpl = null;
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
