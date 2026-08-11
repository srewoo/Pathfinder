/**
 * The job pump (fix.md §4).
 *
 * Executes exactly ONE step per invocation and commits transactionally. The
 * caller (a service-worker alarm) may be killed between any two invocations
 * without losing progress — which is the entire point, since MV3 guarantees it
 * will be.
 *
 * Pure with respect to the browser: persistence arrives as a `JobStore` port and
 * step execution as a `StepExecutor`, so resumption behaviour is testable with
 * an in-memory store and no tab.
 */
import type { Job, JobKind, QueuedTarget, StepOutcome } from './job-model';
import {
  applyOutcome,
  isTerminal,
  markDone,
  markFailed,
  markRunning,
  nextStep,
} from './job-model';
import { createLogger } from '../../utils/logger';

const log = createLogger('job-runner');

// ── Ports ───────────────────────────────────────────────────────────────────

export interface JobStore {
  get(id: string): Promise<Job | null>;
  /**
   * Persist the job AND the step's own result in one transaction.
   *
   * Splitting these is the corruption mode §4 warns about: a resumed run either
   * repeats a step whose result was already written, or skips one whose cursor
   * advanced without its result.
   */
  commit(job: Job, result?: StepResultRecord): Promise<void>;
  /** Oldest resumable job, if any. Drives the pump with no external state. */
  claimResumable(now: number): Promise<Job | null>;
  list(state?: Job['state']): Promise<Job[]>;
}

export interface StepResultRecord {
  jobId: string;
  cursor: number;
  url: string;
  ok: boolean;
  error?: string;
  /** Arbitrary step payload — scanned page, generated tests, etc. */
  payload?: unknown;
}

/** Executes one target. Implementations live outside core (they need a driver). */
export type StepExecutor = (
  target: QueuedTarget,
  job: Job
) => Promise<{ outcome: StepOutcome; payload?: unknown }>;

export interface PumpResult {
  /** True when there is more work — the caller should re-arm its alarm. */
  more: boolean;
  job: Job | null;
  action: 'stepped' | 'finished' | 'aborted' | 'idle';
  reason?: string;
}

// ── The pump ────────────────────────────────────────────────────────────────

/**
 * Claim a resumable job and advance it by one step.
 *
 * `now` is injected rather than read from the clock so tests can control budget
 * arithmetic deterministically.
 */
export async function pumpOnce(
  store: JobStore,
  executors: Partial<Record<JobKind, StepExecutor>>,
  now: () => number = Date.now
): Promise<PumpResult> {
  const claimed = await store.claimResumable(now());
  if (!claimed) return { more: false, job: null, action: 'idle' };
  return stepJob(store, claimed, executors, now);
}

/**
 * Advance a job the caller ALREADY holds by exactly one step.
 *
 * Separate from `pumpOnce` on purpose. Once a step commits, the job is `running`
 * with a fresh `updatedAt`, so `claimResumable` will (correctly) refuse to hand
 * it out again until it goes stale — that refusal is what stops two concurrent
 * pumps double-executing. A pump that wants consecutive steps therefore has to
 * keep hold of the job rather than re-claiming it.
 */
export async function stepJob(
  store: JobStore,
  held: Job,
  executors: Partial<Record<JobKind, StepExecutor>>,
  now: () => number = Date.now
): Promise<PumpResult> {
  let job = held.state === 'running' ? held : markRunning(held, now());

  const step = nextStep(job);

  if (step.kind === 'finish') {
    job = markDone(job, now());
    await store.commit(job);
    log.info(`Job ${job.id} done: ${step.reason} (${job.completedSteps} steps)`);
    return { more: false, job, action: 'finished', reason: step.reason };
  }

  if (step.kind === 'abort') {
    // Paused is not a failure — leave the record alone so a resume can pick it
    // up, and simply stop pumping.
    if (job.state === 'paused') {
      return { more: false, job, action: 'aborted', reason: step.reason };
    }
    job = markFailed(job, step.reason, now());
    await store.commit(job);
    log.warn(`Job ${job.id} aborted: ${step.reason}`);
    return { more: false, job, action: 'aborted', reason: step.reason };
  }

  const executor = executors[job.kind];
  if (!executor) {
    job = markFailed(job, `No executor registered for job kind "${job.kind}"`, now());
    await store.commit(job);
    return { more: false, job, action: 'aborted', reason: job.error };
  }

  const startedAt = now();
  let outcome: StepOutcome;
  let payload: unknown;

  try {
    const res = await executor(step.target, job);
    outcome = res.outcome;
    payload = res.payload;
  } catch (err) {
    // A thrown executor must not lose the step — record it as a failed outcome
    // so the cursor advances and the circuit breaker can count it. Otherwise the
    // pump retries the same broken target forever.
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`Job ${job.id} step ${job.cursor} threw: ${message}`);
    outcome = {
      url: step.target.url,
      elapsedMs: Math.max(1, now() - startedAt),
      ok: false,
      error: message,
    };
  }

  const advanced = applyOutcome(job, outcome, now());

  await store.commit(advanced, {
    jobId: advanced.id,
    cursor: job.cursor,
    url: outcome.url,
    ok: outcome.ok,
    error: outcome.error,
    payload,
  });

  const done = isTerminal(advanced);
  return {
    more: !done,
    job: advanced,
    action: done ? 'aborted' : 'stepped',
    reason: advanced.error,
  };
}

/**
 * Drain up to `maxSteps` in one invocation.
 *
 * A wake-up that runs a single step wastes the startup cost; one that runs to
 * completion gets evicted mid-flight. This bounds the batch so each invocation
 * makes real progress and still commits often enough that eviction is cheap.
 */
export async function pumpBatch(
  store: JobStore,
  executors: Partial<Record<JobKind, StepExecutor>>,
  opts: { maxSteps?: number; maxMs?: number; now?: () => number } = {}
): Promise<PumpResult> {
  const now = opts.now ?? Date.now;
  const maxSteps = opts.maxSteps ?? 10;
  const maxMs = opts.maxMs ?? 20_000;
  const deadline = now() + maxMs;

  // Claim ONCE, then keep hold of the job across steps. Re-claiming each
  // iteration would deadlock against the staleness guard.
  const claimed = await store.claimResumable(now());
  if (!claimed) return { more: false, job: null, action: 'idle' };

  let last: PumpResult = { more: true, job: claimed, action: 'stepped' };

  for (let i = 0; i < maxSteps; i++) {
    const held = last.job;
    if (!held) break;
    last = await stepJob(store, held, executors, now);
    if (!last.more) return last;
    if (now() >= deadline) {
      // Out of time for this invocation, but work remains: report `more` so the
      // caller re-arms rather than treating this as completion.
      return { ...last, more: true };
    }
  }
  return { ...last, more: true };
}
