import { describe, it, expect } from 'vitest';
import {
  MAX_CONSECUTIVE_FAILURES,
  applyOutcome,
  createJob,
  isTerminal,
  markPaused,
  nextStep,
  normalizeUrl,
  progressOf,
  type Job,
} from '../../../src/core/jobs/job-model';

function job(overrides: Partial<Job> = {}): Job {
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

describe('nextStep', () => {
  it('given_a_frontier_then_it_visits_the_first_unvisited_target', () => {
    const s = nextStep(job());
    expect(s.kind).toBe('visit');
    if (s.kind === 'visit') expect(s.target.url).toBe('https://app.test/');
  });

  it('given_an_empty_frontier_then_it_finishes', () => {
    const s = nextStep(job({ frontier: [] }));
    expect(s).toEqual({ kind: 'finish', reason: 'frontier exhausted' });
  });

  it('given_a_frontier_of_already_visited_urls_then_it_finishes', () => {
    // A crash can replay an enqueue, so dedupe-on-enqueue is not sufficient —
    // the visited check has to happen at selection time too.
    const s = nextStep(
      job({
        frontier: [{ url: 'https://app.test/', depth: 0 }],
        visited: ['https://app.test/'],
      })
    );
    expect(s.kind).toBe('finish');
  });

  it('given_an_exhausted_page_budget_then_it_finishes', () => {
    const s = nextStep(job({ budget: { pagesLeft: 0, msLeft: 100, tokensLeft: 100 } }));
    expect(s).toEqual({ kind: 'finish', reason: 'page budget exhausted' });
  });

  it('given_an_exhausted_time_budget_then_it_finishes', () => {
    const s = nextStep(job({ budget: { pagesLeft: 5, msLeft: 0, tokensLeft: 100 } }));
    expect(s).toEqual({ kind: 'finish', reason: 'time budget exhausted' });
  });

  it('given_an_exhausted_token_budget_then_it_finishes', () => {
    const s = nextStep(job({ budget: { pagesLeft: 5, msLeft: 100, tokensLeft: 0 } }));
    expect(s).toEqual({ kind: 'finish', reason: 'token budget exhausted' });
  });

  it('given_the_failure_circuit_breaker_is_open_then_it_aborts', () => {
    const s = nextStep(job({ consecutiveFailures: MAX_CONSECUTIVE_FAILURES }));
    expect(s.kind).toBe('abort');
    if (s.kind === 'abort') expect(s.reason).toMatch(/circuit breaker/);
  });

  it('given_a_paused_job_then_it_aborts_without_failing_it', () => {
    const s = nextStep(markPaused(job(), 2000));
    expect(s).toEqual({ kind: 'abort', reason: 'paused' });
  });

  it('given_the_same_job_twice_then_it_chooses_the_same_step', () => {
    // Determinism is what makes a resumed run continue rather than restart.
    const j = job({
      frontier: [
        { url: 'https://app.test/a', depth: 1 },
        { url: 'https://app.test/b', depth: 1 },
      ],
    });
    expect(nextStep(j)).toEqual(nextStep(j));
  });
});

describe('applyOutcome', () => {
  it('given_a_successful_step_then_cursor_advances_and_url_is_visited', () => {
    const next = applyOutcome(
      job(),
      { url: 'https://app.test/', elapsedMs: 500, ok: true },
      2000
    );
    expect(next.cursor).toBe(1);
    expect(next.visited).toContain('https://app.test/');
    expect(next.frontier).toHaveLength(0);
    expect(next.updatedAt).toBe(2000);
  });

  it('given_discoveries_then_they_are_appended_to_the_frontier', () => {
    const next = applyOutcome(
      job(),
      {
        url: 'https://app.test/',
        discovered: [
          { url: 'https://app.test/a', depth: 1 },
          { url: 'https://app.test/b', depth: 1 },
        ],
        elapsedMs: 10,
        ok: true,
      },
      2000
    );
    expect(next.frontier.map((t) => t.url)).toEqual([
      'https://app.test/a',
      'https://app.test/b',
    ]);
  });

  it('given_a_discovery_that_was_already_visited_then_it_is_not_re_enqueued', () => {
    const next = applyOutcome(
      job({ visited: ['https://app.test/seen'] }),
      {
        url: 'https://app.test/',
        discovered: [{ url: 'https://app.test/seen', depth: 1 }],
        elapsedMs: 10,
        ok: true,
      },
      2000
    );
    expect(next.frontier).toHaveLength(0);
  });

  it('given_duplicate_discoveries_in_one_step_then_only_one_is_enqueued', () => {
    const next = applyOutcome(
      job(),
      {
        url: 'https://app.test/',
        discovered: [
          { url: 'https://app.test/x', depth: 1 },
          { url: 'https://app.test/x#frag', depth: 1 },
        ],
        elapsedMs: 10,
        ok: true,
      },
      2000
    );
    // The fragment does not make it a different page.
    expect(next.frontier).toHaveLength(1);
  });

  it('given_a_failed_step_then_budget_is_still_charged', () => {
    // Not charging for failures is how a broken crawl spins until the clock dies.
    const next = applyOutcome(
      job(),
      { url: 'https://app.test/', elapsedMs: 900, ok: false, error: 'boom' },
      2000
    );
    expect(next.budget.pagesLeft).toBe(9);
    expect(next.budget.msLeft).toBe(60_000 - 900);
    expect(next.consecutiveFailures).toBe(1);
  });

  it('given_a_success_after_failures_then_the_breaker_resets', () => {
    const next = applyOutcome(
      job({ consecutiveFailures: 3 }),
      { url: 'https://app.test/', elapsedMs: 10, ok: true },
      2000
    );
    expect(next.consecutiveFailures).toBe(0);
  });

  it('given_enough_consecutive_failures_then_the_job_is_marked_failed', () => {
    const next = applyOutcome(
      job({ consecutiveFailures: MAX_CONSECUTIVE_FAILURES - 1 }),
      { url: 'https://app.test/', elapsedMs: 10, ok: false, error: 'last straw' },
      2000
    );
    expect(next.state).toBe('failed');
    expect(next.error).toContain('last straw');
    expect(isTerminal(next)).toBe(true);
  });

  it('given_an_outcome_then_the_input_job_is_not_mutated', () => {
    // The caller persists the RETURNED value; mutating in place would let a
    // failed commit leave memory ahead of storage.
    const before = job();
    const snapshot = JSON.parse(JSON.stringify(before));
    applyOutcome(before, { url: 'https://app.test/', elapsedMs: 1, ok: true }, 2000);
    expect(before).toEqual(snapshot);
  });

  it('given_token_usage_then_the_token_budget_decreases', () => {
    const next = applyOutcome(
      job(),
      { url: 'https://app.test/', elapsedMs: 1, ok: true, tokensUsed: 250 },
      2000
    );
    expect(next.budget.tokensLeft).toBe(750);
  });
});

describe('normalizeUrl', () => {
  it('given_a_fragment_then_it_is_stripped', () => {
    expect(normalizeUrl('https://a.test/p#x')).toBe('https://a.test/p');
  });

  it('given_a_trailing_slash_on_a_subpath_then_it_is_removed', () => {
    expect(normalizeUrl('https://a.test/p/')).toBe('https://a.test/p');
  });

  it('given_the_root_then_the_slash_is_preserved', () => {
    expect(normalizeUrl('https://a.test/')).toBe('https://a.test/');
  });

  it('given_a_query_string_then_it_is_preserved', () => {
    // ?page=2 is genuinely different content — stripping it skips real pages.
    expect(normalizeUrl('https://a.test/list?page=2')).toBe('https://a.test/list?page=2');
  });

  it('given_an_unparseable_url_then_it_degrades_gracefully', () => {
    expect(normalizeUrl('junk#frag')).toBe('junk');
  });
});

describe('progressOf', () => {
  it('given_a_fresh_job_then_progress_is_zero', () => {
    expect(progressOf(job()).percent).toBe(0);
  });

  it('given_half_the_frontier_visited_then_progress_is_fifty', () => {
    const p = progressOf(
      job({ visited: ['a', 'b'], frontier: [{ url: 'c', depth: 1 }, { url: 'd', depth: 1 }] })
    );
    expect(p.percent).toBe(50);
    expect(p.visitedCount).toBe(2);
    expect(p.frontierSize).toBe(2);
  });
});
