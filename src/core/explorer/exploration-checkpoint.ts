/**
 * Exploration checkpointing — resumable crawls without the full job rewrite.
 *
 * The graph was already saved incrementally, so an evicted run never lost its
 * DATA. What it lost was its place: the frontier and visited set lived in
 * closures, so a killed worker meant restarting the crawl from the seed and
 * re-walking everything already mapped.
 *
 * §4's job state machine is the complete answer, but migrating the 1372-line
 * explorer onto it is a large refactor. This is the 90% of the benefit at a small
 * fraction of the risk: persist the frontier and visited set on the same
 * incremental cadence the graph already uses, and offer to resume from it.
 *
 * Deliberately NOT presented as full durability. A checkpoint is written between
 * pages, so at most one page of progress is lost — and that is stated rather than
 * rounded up to "survives eviction".
 */
import { z } from 'zod';

export const CHECKPOINT_VERSION = 1;

export const ExplorationCheckpointSchema = z.object({
  version: z.literal(CHECKPOINT_VERSION),
  /** Identifies the run this checkpoint belongs to. */
  runId: z.string().min(1),
  /** The seed the exploration started from. A different seed is a different run. */
  startUrl: z.string(),
  /** Pages still to visit, with their depth. */
  frontier: z.array(z.object({ url: z.string(), depth: z.number().int().nonnegative() })),
  /** Pages already scanned. */
  visited: z.array(z.string()),
  /** Options fingerprint — resuming under different settings is not a resume. */
  optionsHash: z.string(),
  updatedAt: z.number(),
  pagesScanned: z.number().int().nonnegative(),
});

export type ExplorationCheckpoint = z.infer<typeof ExplorationCheckpointSchema>;

/** A checkpoint older than this is stale — the app has probably moved on. */
export const CHECKPOINT_TTL_MS = 6 * 60 * 60 * 1000;

export interface CheckpointStore {
  load(): Promise<unknown>;
  save(value: ExplorationCheckpoint): Promise<void>;
  clear(): Promise<void>;
}

/**
 * Fingerprint the options that change what a crawl WOULD do.
 *
 * Resuming a depth-1 checkpoint into a depth-3 run would silently produce a
 * shallow map labelled as deep, so a changed fingerprint invalidates the
 * checkpoint rather than being ignored.
 */
export function hashOptions(opts: {
  maxDepth?: number;
  maxPages?: number;
  submitForms?: boolean;
  agentMode?: boolean;
}): string {
  const canonical = [
    `d=${opts.maxDepth ?? ''}`,
    `p=${opts.maxPages ?? ''}`,
    `s=${opts.submitForms ? 1 : 0}`,
    `a=${opts.agentMode ? 1 : 0}`,
  ].join('|');
  let hash = 5381;
  for (let i = 0; i < canonical.length; i++) {
    hash = ((hash << 5) + hash + canonical.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

export type ResumeDecision =
  | { resume: true; checkpoint: ExplorationCheckpoint }
  | { resume: false; reason: string };

/**
 * Decide whether a stored checkpoint may be resumed.
 *
 * Every rejection reason is reported. A silent refusal would present a full
 * restart as a resume, and the user would see the crawl re-walk pages it already
 * had with no explanation.
 */
export function evaluateCheckpoint(
  raw: unknown,
  current: { startUrl: string; optionsHash: string; now: number }
): ResumeDecision {
  const parsed = ExplorationCheckpointSchema.safeParse(raw);
  if (!parsed.success) {
    return { resume: false, reason: 'no usable checkpoint (absent or from an older version)' };
  }
  const cp = parsed.data;

  if (cp.startUrl !== current.startUrl) {
    return {
      resume: false,
      reason: `checkpoint was for ${cp.startUrl}, this run starts at ${current.startUrl}`,
    };
  }
  if (cp.optionsHash !== current.optionsHash) {
    return {
      resume: false,
      reason: 'exploration options changed since the checkpoint — resuming would mislabel the result',
    };
  }
  if (current.now - cp.updatedAt > CHECKPOINT_TTL_MS) {
    const hours = Math.round((current.now - cp.updatedAt) / 3_600_000);
    return { resume: false, reason: `checkpoint is ${hours}h old — the app has likely changed` };
  }
  if (cp.frontier.length === 0) {
    return { resume: false, reason: 'checkpoint has an empty frontier — the previous run finished' };
  }

  return { resume: true, checkpoint: cp };
}

export function createCheckpoint(input: {
  runId: string;
  startUrl: string;
  optionsHash: string;
  frontier: ReadonlyArray<{ url: string; depth: number }>;
  visited: Iterable<string>;
  pagesScanned: number;
  now: number;
}): ExplorationCheckpoint {
  return ExplorationCheckpointSchema.parse({
    version: CHECKPOINT_VERSION,
    runId: input.runId,
    startUrl: input.startUrl,
    frontier: input.frontier.map((f) => ({ url: f.url, depth: f.depth })),
    visited: [...input.visited],
    optionsHash: input.optionsHash,
    updatedAt: input.now,
    pagesScanned: input.pagesScanned,
  });
}

export function describeResume(decision: ResumeDecision): string {
  if (!decision.resume) return `Starting fresh: ${decision.reason}`;
  const cp = decision.checkpoint;
  return (
    `Resuming exploration: ${cp.visited.length} page(s) already mapped, ` +
    `${cp.frontier.length} still queued (at most one page of progress lost to the interruption)`
  );
}
