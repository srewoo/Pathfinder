/**
 * The pump's contract: a crawl survives worker eviction.
 *
 * These tests are the reason §4 exists — they simulate the service worker being
 * killed mid-run and assert the run continues from where it stopped rather than
 * restarting or losing progress.
 */
import { describe, it, expect, vi } from 'vitest';
import { createJob, type Job, type QueuedTarget } from '../../../src/core/jobs/job-model';
import { pumpBatch, pumpOnce, type StepExecutor } from '../../../src/core/jobs/job-runner';
import { createInMemoryJobStore } from '../../../src/storage/job-db';

function seedJob(overrides: Partial<Job> = {}): Job {
  return {
    ...createJob({
      id: 'j1',
      kind: 'crawl',
      seeds: [{ url: 'https://app.test/', depth: 0 }],
      budget: { pagesLeft: 10, msLeft: 60_000, tokensLeft: 1000 },
      now: 1000,
    }),
    ...overrides,
  };
}

/** Executor that discovers `linksPerPage` children, up to `maxDepth`. */
function crawlingExecutor(linksPerPage = 2, maxDepth = 1): StepExecutor {
  let n = 0;
  return async (target: QueuedTarget) => {
    const discovered: QueuedTarget[] =
      target.depth < maxDepth
        ? Array.from({ length: linksPerPage }, (_, i) => ({
            url: `${target.url}child-${++n}-${i}`,
            depth: target.depth + 1,
          }))
        : [];
    return {
      outcome: { url: target.url, discovered, elapsedMs: 100, ok: true },
      payload: { scanned: target.url },
    };
  };
}

describe('pumpOnce', () => {
  it('given_no_jobs_then_it_reports_idle', async () => {
    const store = createInMemoryJobStore([]);
    const r = await pumpOnce(store, { crawl: crawlingExecutor() });
    expect(r.action).toBe('idle');
    expect(r.more).toBe(false);
  });

  it('given_a_queued_job_then_one_step_runs_and_state_becomes_running', async () => {
    const store = createInMemoryJobStore([seedJob()]);
    const r = await pumpOnce(store, { crawl: crawlingExecutor() }, () => 2000);
    expect(r.action).toBe('stepped');
    expect(r.job?.state).toBe('running');
    expect(r.job?.cursor).toBe(1);
    expect(r.job?.visited).toContain('https://app.test/');
  });

  it('given_a_step_then_the_result_is_committed_alongside_the_job', async () => {
    // Job record and step result must land together — a partial commit is what
    // makes a resumed run repeat or skip work.
    const store = createInMemoryJobStore([seedJob()]);
    await pumpOnce(store, { crawl: crawlingExecutor() }, () => 2000);
    const [result] = store.results();
    expect(result.jobId).toBe('j1');
    expect(result.cursor).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.payload).toEqual({ scanned: 'https://app.test/' });
  });

  it('given_an_exhausted_frontier_then_the_job_finishes', async () => {
    const store = createInMemoryJobStore([
      seedJob({ frontier: [], state: 'queued' }),
    ]);
    const r = await pumpOnce(store, { crawl: crawlingExecutor() }, () => 2000);
    expect(r.action).toBe('finished');
    expect(r.job?.state).toBe('done');
    expect(r.more).toBe(false);
  });

  it('given_an_executor_that_throws_then_the_step_is_recorded_as_failed_and_the_cursor_advances', async () => {
    // Without this the pump retries the same broken target forever.
    const store = createInMemoryJobStore([seedJob()]);
    const boom: StepExecutor = async () => {
      throw new Error('page exploded');
    };
    const r = await pumpOnce(store, { crawl: boom }, () => 2000);
    expect(r.job?.cursor).toBe(1);
    expect(r.job?.consecutiveFailures).toBe(1);
    expect(store.results()[0].ok).toBe(false);
    expect(store.results()[0].error).toBe('page exploded');
  });

  it('given_no_executor_for_the_kind_then_the_job_fails_loudly', async () => {
    const store = createInMemoryJobStore([seedJob({ kind: 'generate' })]);
    const r = await pumpOnce(store, { crawl: crawlingExecutor() }, () => 2000);
    expect(r.job?.state).toBe('failed');
    expect(r.job?.error).toMatch(/No executor registered/);
  });

  it('given_a_paused_job_then_it_is_not_claimed', async () => {
    const store = createInMemoryJobStore([seedJob({ state: 'paused' })]);
    const r = await pumpOnce(store, { crawl: crawlingExecutor() }, () => 2000);
    expect(r.action).toBe('idle');
  });

  it('given_a_done_job_then_it_is_not_reclaimed', async () => {
    const store = createInMemoryJobStore([seedJob({ state: 'done' })]);
    expect((await pumpOnce(store, { crawl: crawlingExecutor() })).action).toBe('idle');
  });
});

describe('worker eviction survival (the §4 exit criterion)', () => {
  it('given_the_worker_dies_mid_run_then_the_job_resumes_from_its_cursor', async () => {
    const store = createInMemoryJobStore([seedJob()]);
    const exec = crawlingExecutor(2, 1);

    // Two steps in one invocation (a real pump holds its job across steps),
    // then the worker is killed while the job is still 'running'.
    await pumpBatch(store, { crawl: exec }, { maxSteps: 2, now: () => 2000 });
    const midway = await store.get('j1');
    expect(midway?.cursor).toBe(2);
    expect(midway?.state).toBe('running');

    // Simulate eviction: nothing updates the record, so it goes stale.
    store.evict('j1');

    // A fresh pump reclaims it and CONTINUES — cursor moves forward, and the
    // already-visited pages are not revisited.
    const resumed = await pumpOnce(store, { crawl: exec }, () => 200_000);
    expect(resumed.action).toBe('stepped');
    expect(resumed.job?.cursor).toBe(3);
    expect(resumed.job?.visited).toHaveLength(3);
    expect(new Set(resumed.job?.visited).size).toBe(3);
  });

  it('given_a_fresh_running_job_then_it_is_NOT_stolen_by_a_second_pump', async () => {
    // Reclaim must require staleness, or two concurrent pumps double-execute.
    // This is also why pumpBatch holds its job instead of re-claiming per step.
    const store = createInMemoryJobStore([seedJob()]);
    await pumpOnce(store, { crawl: crawlingExecutor() }, () => 2000);
    const r = await pumpOnce(store, { crawl: crawlingExecutor() }, () => 2500);
    expect(r.action).toBe('idle');
  });

  it('given_a_completed_crawl_then_every_discovered_page_was_visited_exactly_once', async () => {
    const store = createInMemoryJobStore([seedJob()]);
    const exec = crawlingExecutor(2, 1);

    // Drain to completion across many invocations, evicting between each to
    // prove idempotency under repeated interruption.
    let clock = 2000;
    for (let i = 0; i < 20; i++) {
      const r = await pumpOnce(store, { crawl: exec }, () => (clock += 100_000));
      if (!r.more) break;
      store.evict('j1');
    }

    const final = await store.get('j1');
    expect(final?.state).toBe('done');
    // 1 root + 2 children = 3 pages, no duplicates.
    expect(final?.visited).toHaveLength(3);
    expect(new Set(final?.visited).size).toBe(3);
  });
});

describe('pumpBatch', () => {
  it('given_a_batch_then_it_runs_multiple_steps_in_one_invocation', async () => {
    const store = createInMemoryJobStore([seedJob()]);
    const r = await pumpBatch(store, { crawl: crawlingExecutor(2, 1) }, {
      maxSteps: 10,
      now: () => 2000,
    });
    expect(r.more).toBe(false);
    const final = await store.get('j1');
    expect(final?.state).toBe('done');
    expect(final?.visited).toHaveLength(3);
  });

  it('given_maxSteps_is_reached_then_it_reports_more_work_remains', async () => {
    const store = createInMemoryJobStore([seedJob()]);
    const r = await pumpBatch(store, { crawl: crawlingExecutor(3, 2) }, {
      maxSteps: 2,
      now: () => 2000,
    });
    expect(r.more).toBe(true);
    expect((await store.get('j1'))?.state).toBe('running');
  });

  it('given_the_time_budget_for_the_invocation_elapses_then_it_yields_with_more_true', async () => {
    const store = createInMemoryJobStore([seedJob()]);
    let t = 0;
    // Each read advances the clock, so the invocation deadline trips quickly.
    const now = () => (t += 5_000);
    const r = await pumpBatch(store, { crawl: crawlingExecutor(3, 2) }, {
      maxSteps: 100,
      maxMs: 10_000,
      now,
    });
    expect(r.more).toBe(true);
  });

  it('given_an_idle_store_then_the_batch_reports_idle_without_calling_the_executor', async () => {
    const store = createInMemoryJobStore([]);
    const exec = vi.fn();
    const r = await pumpBatch(store, { crawl: exec as unknown as StepExecutor }, {
      now: () => 1,
    });
    expect(r.action).toBe('idle');
    expect(exec).not.toHaveBeenCalled();
  });
});
