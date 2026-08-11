/**
 * Alarm-driven job pump (fix.md §4).
 *
 * Replaces the "keep the service worker alive and hope" strategy. The worker is
 * now disposable: an alarm wakes it, it drains a bounded batch of steps,
 * commits each one, re-arms if work remains, and exits. Eviction between any two
 * steps costs at most the step in flight.
 *
 * `chrome.alarms` has a 30-second minimum period in practice, so a batch is
 * sized to make real progress per wake rather than one step at a time.
 */
import type { JobKind } from '../core/jobs/job-model';
import { progressOf } from '../core/jobs/job-model';
import type { StepExecutor } from '../core/jobs/job-runner';
import { pumpBatch } from '../core/jobs/job-runner';
import { jobStore } from '../storage/job-db';
import { createLogger } from '../utils/logger';

const log = createLogger('job-pump');

export const PUMP_ALARM = 'pathfinder-job-pump';

/** Steps per wake. Bounded so a commit happens often enough to survive eviction. */
const MAX_STEPS_PER_WAKE = 8;
/** Wall-clock ceiling per wake, comfortably inside the MV3 idle budget. */
const MAX_MS_PER_WAKE = 20_000;

const executors: Partial<Record<JobKind, StepExecutor>> = {};

/**
 * Register the executor for a job kind.
 *
 * Executors live outside `core` because they need a driver and a tab; the pump
 * only knows the port. Registration happens at service-worker startup, which
 * matters: after an eviction the worker restarts and MUST re-register before the
 * alarm fires, or a resumable job fails with "no executor registered".
 */
export function registerExecutor(kind: JobKind, executor: StepExecutor): void {
  executors[kind] = executor;
}

export function registeredKinds(): JobKind[] {
  return Object.keys(executors) as JobKind[];
}

/** Start pumping. Safe to call repeatedly — the alarm is replaced, not stacked. */
export async function armPump(): Promise<void> {
  await chrome.alarms.create(PUMP_ALARM, { periodInMinutes: 0.5 });
  log.info('Job pump armed');
}

export async function disarmPump(): Promise<void> {
  await chrome.alarms.clear(PUMP_ALARM);
  log.info('Job pump disarmed');
}

/**
 * One wake. Drains a batch, then either re-arms or disarms.
 *
 * Never throws: an alarm handler that rejects loses the wake and, with it, the
 * run. Failures are logged and the pump stays armed so the next wake can retry.
 */
export async function onPumpWake(): Promise<void> {
  try {
    const result = await pumpBatch(jobStore, executors, {
      maxSteps: MAX_STEPS_PER_WAKE,
      maxMs: MAX_MS_PER_WAKE,
    });

    if (result.action === 'idle') {
      // Nothing to do — stop waking up. `armPump` is called again when a job is
      // enqueued, so an idle pump costs nothing.
      await disarmPump();
      return;
    }

    if (result.job) {
      const p = progressOf(result.job);
      log.info(
        `Job ${result.job.id} [${result.job.state}] ${p.visitedCount} done, ` +
          `${p.frontierSize} queued (${p.percent}%)`
      );
    }

    if (!result.more) {
      await disarmPump();
      log.info(`Pump finished: ${result.action}${result.reason ? ` — ${result.reason}` : ''}`);
    }
  } catch (err) {
    // Stay armed. A transient IndexedDB or driver failure must not end the run.
    log.error('Pump wake failed — staying armed for the next wake', err);
  }
}

/**
 * Install the alarm listener. Call once at service-worker top level, NOT inside
 * an event handler: listeners must be registered synchronously on every worker
 * start for Chrome to route the alarm to a restarted worker.
 */
export function installPumpListener(): void {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== PUMP_ALARM) return;
    void onPumpWake();
  });
}

/**
 * Resume any job left running by an evicted worker.
 *
 * Called at startup. Without it, a crawl interrupted by eviction sits idle until
 * the user happens to start something else — the progress is durable but nothing
 * is driving it forward.
 */
export async function resumeInterruptedJobs(): Promise<number> {
  const resumable = [...(await jobStore.list('running')), ...(await jobStore.list('queued'))];
  if (resumable.length === 0) return 0;
  log.info(`Found ${resumable.length} interrupted job(s) — re-arming pump`);
  await armPump();
  return resumable.length;
}
