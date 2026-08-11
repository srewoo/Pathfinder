/**
 * Durable job model (fix.md §4).
 *
 * A crawl is a long-running job whose worker can die at any moment: MV3 evicts
 * the service worker after ~30s idle. Modelling it as in-memory `async` loops
 * meant eviction lost the run, which is why the old orchestrator needed the
 * `alarms` permission and still lost progress.
 *
 * Here the job IS the state. The worker is a disposable pump:
 *
 *   wake → load job → execute ONE step → commit transactionally → re-arm → exit
 *
 * This module is PURE — no chrome, no IndexedDB, no I/O. It decides what the
 * next step is and how a step's outcome mutates the job. That makes resumption
 * semantics unit-testable, which is the only way to have any confidence in them.
 */
import { z } from 'zod';

// ── Schema ──────────────────────────────────────────────────────────────────

export const JobKindSchema = z.enum(['crawl', 'explore', 'generate', 'execute']);
export type JobKind = z.infer<typeof JobKindSchema>;

export const JobStateSchema = z.enum(['queued', 'running', 'paused', 'done', 'failed']);
export type JobState = z.infer<typeof JobStateSchema>;

export const QueuedTargetSchema = z.object({
  url: z.string(),
  depth: z.number().int().nonnegative(),
  /** Where this target came from — used for the interaction graph edge. */
  via: z.string().optional(),
});
export type QueuedTarget = z.infer<typeof QueuedTargetSchema>;

export const JobBudgetSchema = z.object({
  pagesLeft: z.number().int(),
  msLeft: z.number().int(),
  tokensLeft: z.number().int(),
});
export type JobBudget = z.infer<typeof JobBudgetSchema>;

export const JobSchema = z.object({
  id: z.string().min(1),
  kind: JobKindSchema,
  state: JobStateSchema,
  /** Index of the next step to run. Monotonic; never rewound. */
  cursor: z.number().int().nonnegative(),
  /** BFS queue — persisted, never only in a closure. */
  frontier: z.array(QueuedTargetSchema),
  /** URLs already handled. Also the idempotency key set. */
  visited: z.array(z.string()),
  budget: JobBudgetSchema,
  /** Job-specific configuration, opaque here. */
  config: z.record(z.unknown()).default({}),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Set when state is 'failed'. */
  error: z.string().optional(),
  /** Steps completed — for progress reporting, capped. */
  completedSteps: z.number().int().nonnegative().default(0),
  /** Consecutive step failures. Trips the circuit breaker. */
  consecutiveFailures: z.number().int().nonnegative().default(0),
});

export type Job = z.infer<typeof JobSchema>;

// ── Step planning ───────────────────────────────────────────────────────────

export type NextStep =
  | { kind: 'visit'; target: QueuedTarget }
  | { kind: 'finish'; reason: string }
  | { kind: 'abort'; reason: string };

/** A job fails permanently after this many consecutive step failures. */
export const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * Decide the next step from persisted state alone.
 *
 * Deliberately a pure function of `job`: given the same job record, the same
 * step is chosen. That is what makes a resumed run continue rather than restart,
 * and what makes this testable.
 */
export function nextStep(job: Job): NextStep {
  if (job.state === 'done') return { kind: 'finish', reason: 'already done' };
  if (job.state === 'failed') return { kind: 'abort', reason: job.error ?? 'already failed' };
  if (job.state === 'paused') return { kind: 'abort', reason: 'paused' };

  if (job.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    return {
      kind: 'abort',
      reason: `${job.consecutiveFailures} consecutive step failures — circuit breaker open`,
    };
  }

  if (job.budget.pagesLeft <= 0) return { kind: 'finish', reason: 'page budget exhausted' };
  if (job.budget.msLeft <= 0) return { kind: 'finish', reason: 'time budget exhausted' };
  if (job.budget.tokensLeft <= 0) return { kind: 'finish', reason: 'token budget exhausted' };

  // Skip targets already visited — the frontier can contain duplicates when two
  // pages link to the same place, and deduping on enqueue alone is not enough
  // because a crash can replay an enqueue.
  const visited = new Set(job.visited);
  for (const target of job.frontier) {
    if (!visited.has(normalizeUrl(target.url))) {
      return { kind: 'visit', target };
    }
  }

  return { kind: 'finish', reason: 'frontier exhausted' };
}

// ── Transitions ─────────────────────────────────────────────────────────────

export interface StepOutcome {
  /** URL that was handled. Added to `visited`. */
  url: string;
  /** New targets discovered. Deduped against visited and the existing frontier. */
  discovered?: QueuedTarget[];
  /** Wall-clock cost of the step. */
  elapsedMs: number;
  /** Tokens spent by the step, if any. */
  tokensUsed?: number;
  ok: boolean;
  error?: string;
}

/**
 * Apply a step outcome, returning the NEXT job record.
 *
 * Never mutates the input: the caller persists the returned value in a single
 * transaction alongside the step's own result. A partial commit — step result
 * written, cursor not advanced — is the failure mode that makes a resumed run
 * repeat work or skip it, so the two must move together.
 */
export function applyOutcome(job: Job, outcome: StepOutcome, now: number): Job {
  const visitedUrl = normalizeUrl(outcome.url);
  const visited = job.visited.includes(visitedUrl) ? job.visited : [...job.visited, visitedUrl];

  // Drop the handled target, then append genuinely new discoveries.
  const remaining = job.frontier.filter((t) => normalizeUrl(t.url) !== visitedUrl);
  const known = new Set([...visited, ...remaining.map((t) => normalizeUrl(t.url))]);
  const fresh = (outcome.discovered ?? []).filter((t) => {
    const n = normalizeUrl(t.url);
    if (known.has(n)) return false;
    known.add(n);
    return true;
  });

  const consecutiveFailures = outcome.ok ? 0 : job.consecutiveFailures + 1;

  const next: Job = {
    ...job,
    cursor: job.cursor + 1,
    completedSteps: job.completedSteps + 1,
    visited,
    frontier: [...remaining, ...fresh],
    budget: {
      // A failed step still consumed a page slot and wall-clock — not charging
      // for failures is how a broken crawl loops until the time budget dies.
      pagesLeft: job.budget.pagesLeft - 1,
      msLeft: job.budget.msLeft - outcome.elapsedMs,
      tokensLeft: job.budget.tokensLeft - (outcome.tokensUsed ?? 0),
    },
    consecutiveFailures,
    updatedAt: now,
    error: outcome.ok ? job.error : outcome.error,
  };

  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    return {
      ...next,
      state: 'failed',
      error: `${consecutiveFailures} consecutive step failures. Last: ${outcome.error ?? 'unknown'}`,
    };
  }

  return next;
}

export function createJob(input: {
  id: string;
  kind: JobKind;
  seeds: QueuedTarget[];
  budget: JobBudget;
  config?: Record<string, unknown>;
  now: number;
}): Job {
  return JobSchema.parse({
    id: input.id,
    kind: input.kind,
    state: 'queued',
    cursor: 0,
    frontier: input.seeds,
    visited: [],
    budget: input.budget,
    config: input.config ?? {},
    createdAt: input.now,
    updatedAt: input.now,
    completedSteps: 0,
    consecutiveFailures: 0,
  });
}

export function markRunning(job: Job, now: number): Job {
  return { ...job, state: 'running', updatedAt: now };
}

export function markDone(job: Job, now: number): Job {
  return { ...job, state: 'done', updatedAt: now };
}

export function markPaused(job: Job, now: number): Job {
  return { ...job, state: 'paused', updatedAt: now };
}

export function markFailed(job: Job, error: string, now: number): Job {
  return { ...job, state: 'failed', error, updatedAt: now };
}

/** Terminal jobs are never resumed by the pump. */
export function isTerminal(job: Job): boolean {
  return job.state === 'done' || job.state === 'failed';
}

export interface JobProgress {
  completedSteps: number;
  frontierSize: number;
  visitedCount: number;
  pagesLeft: number;
  percent: number;
}

export function progressOf(job: Job): JobProgress {
  const done = job.visited.length;
  const total = done + job.frontier.length;
  return {
    completedSteps: job.completedSteps,
    frontierSize: job.frontier.length,
    visitedCount: done,
    pagesLeft: job.budget.pagesLeft,
    percent: total === 0 ? 0 : Math.min(100, Math.round((done / total) * 100)),
  };
}

/**
 * URL identity for the visited set.
 *
 * Fragments never identify a distinct page, and a trailing slash on the root is
 * the same page. Query strings ARE kept — `?page=2` is genuinely different
 * content. Getting this wrong either re-crawls forever or skips real pages.
 */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    if (u.pathname !== '/' && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return url.split('#')[0];
  }
}
