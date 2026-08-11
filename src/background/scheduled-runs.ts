/**
 * Scheduled runs (fix.md §11).
 *
 * Covers the recurring-regression use case that motivated the CLI, for anyone
 * willing to leave a browser open. A schedule enqueues a durable job (§4) rather
 * than executing inline, so a scheduled run inherits eviction survival for free.
 *
 * Deliberately modest: this is not a CI replacement and should not be described
 * as one. It runs when Chrome is open and the extension is installed.
 */
import { z } from 'zod';
import { createJob } from '../core/jobs/job-model';
import { jobStore } from '../storage/job-db';
import { armPump } from './job-pump';
import { createLogger } from '../utils/logger';

const log = createLogger('scheduled-runs');

export const SCHEDULE_ALARM_PREFIX = 'pathfinder-schedule:';

export const ScheduleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Minutes between runs. Chrome enforces a 1-minute floor for alarms. */
  everyMinutes: z.number().int().min(1),
  startUrl: z.string().url(),
  /** Origins the run may touch (§7). Required — no schedule runs unscoped. */
  allowedOrigins: z.array(z.string().min(1)).min(1),
  /** Mutating runs must be opted into explicitly, per §7. */
  allowMutations: z.boolean().default(false),
  maxPages: z.number().int().positive().default(50),
  enabled: z.boolean().default(true),
});

export type Schedule = z.infer<typeof ScheduleSchema>;

const STORAGE_KEY = 'pathfinder.schedules';

export async function listSchedules(): Promise<Schedule[]> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const raw = stored[STORAGE_KEY];
  if (!Array.isArray(raw)) return [];
  // Validate on read (§12): a corrupt schedule must not silently run with
  // defaults — especially `allowedOrigins`, where a wrong default is unsafe.
  const out: Schedule[] = [];
  for (const item of raw) {
    const parsed = ScheduleSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
    else log.error(`Discarding corrupt schedule: ${parsed.error.message}`);
  }
  return out;
}

export async function saveSchedule(input: unknown): Promise<Schedule> {
  const schedule = ScheduleSchema.parse(input);
  const all = (await listSchedules()).filter((s) => s.id !== schedule.id);
  all.push(schedule);
  await chrome.storage.local.set({ [STORAGE_KEY]: all });
  await syncAlarms();
  return schedule;
}

export async function deleteSchedule(id: string): Promise<void> {
  const all = (await listSchedules()).filter((s) => s.id !== id);
  await chrome.storage.local.set({ [STORAGE_KEY]: all });
  await chrome.alarms.clear(`${SCHEDULE_ALARM_PREFIX}${id}`);
  await syncAlarms();
}

/**
 * Reconcile alarms with stored schedules.
 *
 * Idempotent and safe to call on every worker start — which is necessary,
 * because alarms survive worker eviction but the listener registration does not.
 */
export async function syncAlarms(): Promise<void> {
  const schedules = await listSchedules();
  const wanted = new Set(
    schedules.filter((s) => s.enabled).map((s) => `${SCHEDULE_ALARM_PREFIX}${s.id}`)
  );

  const existing = await chrome.alarms.getAll();
  for (const alarm of existing) {
    if (alarm.name.startsWith(SCHEDULE_ALARM_PREFIX) && !wanted.has(alarm.name)) {
      await chrome.alarms.clear(alarm.name);
    }
  }

  for (const schedule of schedules) {
    if (!schedule.enabled) continue;
    await chrome.alarms.create(`${SCHEDULE_ALARM_PREFIX}${schedule.id}`, {
      periodInMinutes: schedule.everyMinutes,
    });
  }

  log.info(`Synced ${wanted.size} schedule alarm(s)`);
}

/**
 * Fire a schedule: enqueue a job and arm the pump.
 *
 * Note what this does NOT do — run the crawl inline. Enqueuing means a scheduled
 * run that outlives the worker still completes.
 */
export async function runSchedule(id: string, now = Date.now()): Promise<string | null> {
  const schedule = (await listSchedules()).find((s) => s.id === id);
  if (!schedule) {
    log.warn(`Schedule ${id} fired but no longer exists — clearing its alarm`);
    await chrome.alarms.clear(`${SCHEDULE_ALARM_PREFIX}${id}`);
    return null;
  }
  if (!schedule.enabled) return null;

  const jobId = `sched-${schedule.id}-${now}`;
  const job = createJob({
    id: jobId,
    kind: 'explore',
    seeds: [{ url: schedule.startUrl, depth: 0 }],
    budget: {
      pagesLeft: schedule.maxPages,
      msLeft: 30 * 60_000,
      tokensLeft: 200_000,
    },
    config: {
      scheduleId: schedule.id,
      allowedOrigins: schedule.allowedOrigins,
      allowMutations: schedule.allowMutations,
    },
    now,
  });

  await jobStore.commit(job);
  await armPump();
  log.info(`Schedule "${schedule.name}" enqueued job ${jobId}`);
  return jobId;
}

/** Register the alarm listener. Call at service-worker top level. */
export function installScheduleListener(): void {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm.name.startsWith(SCHEDULE_ALARM_PREFIX)) return;
    const id = alarm.name.slice(SCHEDULE_ALARM_PREFIX.length);
    void runSchedule(id).catch((err) => log.error(`Schedule ${id} failed to start`, err));
  });
}
