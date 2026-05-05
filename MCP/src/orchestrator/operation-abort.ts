/**
 * Operation Abort Registry
 *
 * Maintains active AbortControllers for long-running MCP operations.
 * Tools call startOperation() to get an AbortSignal; the cancel_operation
 * tool calls stopOperation() to abort them.
 */

import { createLogger } from '../utils/logger.js';

const log = createLogger('abort-registry');

const activeControllers = new Map<string, AbortController>();

/** Start a named operation. Returns an AbortSignal to thread through the operation. */
export function startOperation(name: string): AbortSignal {
  // Abort any previous instance of the same operation
  const existing = activeControllers.get(name);
  if (existing && !existing.signal.aborted) {
    log.info(`Aborting previous ${name} operation before starting new one`);
    existing.abort();
  }
  const controller = new AbortController();
  activeControllers.set(name, controller);
  return controller.signal;
}

/** Abort a named operation. Returns true if an operation was running. */
export function stopOperation(name: string): boolean {
  const controller = activeControllers.get(name);
  if (!controller || controller.signal.aborted) {
    activeControllers.delete(name);
    return false;
  }
  controller.abort();
  activeControllers.delete(name);
  log.info(`Operation "${name}" stopped by user`);
  return true;
}

/** Mark a named operation as finished (removes from registry). */
export function finishOperation(name: string): void {
  activeControllers.delete(name);
}

/** List currently active operation names. */
export function listActiveOperations(): string[] {
  return [...activeControllers.entries()]
    .filter(([, c]) => !c.signal.aborted)
    .map(([name]) => name);
}
