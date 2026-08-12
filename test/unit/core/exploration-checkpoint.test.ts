/**
 * Exploration checkpointing.
 *
 * The interesting cases are the REFUSALS. Resuming a checkpoint that no longer
 * matches the run would produce a map that is silently wrong — a shallow crawl
 * labelled deep, or a stale graph presented as current. Each refusal must also
 * state its reason, because a silent restart looks like the crawl inexplicably
 * re-walking pages it already had.
 */
import { describe, it, expect } from 'vitest';
import {
  CHECKPOINT_TTL_MS,
  CHECKPOINT_VERSION,
  createCheckpoint,
  describeResume,
  evaluateCheckpoint,
  hashOptions,
} from '../../../src/core/explorer/exploration-checkpoint';

const NOW = 1_700_000_000_000;
const START = 'https://app.test/';

const checkpoint = (over: Record<string, unknown> = {}) =>
  createCheckpoint({
    runId: 'run-1',
    startUrl: START,
    optionsHash: hashOptions({ maxDepth: 2, maxPages: 50 }),
    frontier: [{ url: 'https://app.test/a', depth: 1 }],
    visited: [START],
    pagesScanned: 1,
    now: NOW,
    ...over,
  } as never);

const current = (over: Record<string, unknown> = {}) => ({
  startUrl: START,
  optionsHash: hashOptions({ maxDepth: 2, maxPages: 50 }),
  now: NOW,
  ...over,
});

describe('resume accepted', () => {
  it('given_a_matching_recent_checkpoint_then_it_resumes', () => {
    const d = evaluateCheckpoint(checkpoint(), current());
    expect(d.resume).toBe(true);
    if (d.resume) expect(d.checkpoint.visited).toEqual([START]);
  });

  it('given_a_resume_then_the_description_is_honest_about_what_was_lost', () => {
    // "Survives eviction" would be an overclaim: a checkpoint is written between
    // pages, so one page of progress can still be lost.
    const text = describeResume(evaluateCheckpoint(checkpoint(), current()));
    expect(text).toMatch(/Resuming/);
    expect(text).toMatch(/one page of progress/);
  });
});

describe('resume refused, with a stated reason', () => {
  it('given_a_different_start_url_then_it_refuses_and_names_both', () => {
    const d = evaluateCheckpoint(checkpoint(), current({ startUrl: 'https://other.test/' }));
    expect(d.resume).toBe(false);
    if (!d.resume) {
      expect(d.reason).toContain('https://app.test/');
      expect(d.reason).toContain('https://other.test/');
    }
  });

  it('given_changed_depth_then_it_refuses_because_resuming_would_mislabel_the_result', () => {
    // A depth-1 frontier resumed into a depth-3 run yields a shallow map presented
    // as deep — the most dangerous kind of wrong.
    const d = evaluateCheckpoint(
      checkpoint(),
      current({ optionsHash: hashOptions({ maxDepth: 3, maxPages: 50 }) })
    );
    expect(d.resume).toBe(false);
    if (!d.resume) expect(d.reason).toMatch(/options changed/);
  });

  it('given_a_changed_submitForms_flag_then_it_refuses', () => {
    // Mutating vs read-only are different runs entirely.
    const d = evaluateCheckpoint(
      checkpoint(),
      current({ optionsHash: hashOptions({ maxDepth: 2, maxPages: 50, submitForms: true }) })
    );
    expect(d.resume).toBe(false);
  });

  it('given_a_stale_checkpoint_then_it_refuses_and_reports_its_age', () => {
    const d = evaluateCheckpoint(
      checkpoint(),
      current({ now: NOW + CHECKPOINT_TTL_MS + 3_600_000 })
    );
    expect(d.resume).toBe(false);
    if (!d.resume) expect(d.reason).toMatch(/\d+h old/);
  });

  it('given_an_empty_frontier_then_it_refuses_because_the_run_finished', () => {
    const d = evaluateCheckpoint(checkpoint({ frontier: [] }), current());
    expect(d.resume).toBe(false);
    if (!d.resume) expect(d.reason).toMatch(/finished/);
  });

  it('given_no_checkpoint_then_it_refuses_without_throwing', () => {
    for (const raw of [undefined, null, {}, 'garbage', 42]) {
      const d = evaluateCheckpoint(raw, current());
      expect(d.resume).toBe(false);
    }
  });

  it('given_a_checkpoint_from_an_older_version_then_it_refuses', () => {
    const old = { ...checkpoint(), version: CHECKPOINT_VERSION - 1 };
    expect(evaluateCheckpoint(old, current()).resume).toBe(false);
  });

  it('given_every_refusal_then_the_description_explains_the_restart', () => {
    const text = describeResume(evaluateCheckpoint(undefined, current()));
    expect(text).toMatch(/^Starting fresh: /);
  });
});

describe('hashOptions', () => {
  it('given_identical_options_then_the_hash_is_stable', () => {
    expect(hashOptions({ maxDepth: 2, maxPages: 10 })).toBe(hashOptions({ maxDepth: 2, maxPages: 10 }));
  });

  it('given_any_behaviour_changing_option_then_the_hash_differs', () => {
    const base = hashOptions({ maxDepth: 2, maxPages: 10, submitForms: false, agentMode: false });
    expect(hashOptions({ maxDepth: 3, maxPages: 10 })).not.toBe(base);
    expect(hashOptions({ maxDepth: 2, maxPages: 20 })).not.toBe(base);
    expect(hashOptions({ maxDepth: 2, maxPages: 10, submitForms: true })).not.toBe(base);
    expect(hashOptions({ maxDepth: 2, maxPages: 10, agentMode: true })).not.toBe(base);
  });
});

describe('createCheckpoint', () => {
  it('given_a_visited_set_then_it_serializes_to_an_array', () => {
    const cp = createCheckpoint({
      runId: 'r',
      startUrl: START,
      optionsHash: 'h',
      frontier: [],
      visited: new Set([START, 'https://app.test/a']),
      pagesScanned: 2,
      now: NOW,
    });
    expect(cp.visited).toEqual([START, 'https://app.test/a']);
  });

  it('given_an_invalid_shape_then_it_throws_at_creation_rather_than_on_read', () => {
    // Failing at write time keeps a corrupt checkpoint out of storage entirely.
    expect(() =>
      createCheckpoint({
        runId: '',
        startUrl: START,
        optionsHash: 'h',
        frontier: [],
        visited: [],
        pagesScanned: 0,
        now: NOW,
      })
    ).toThrow();
  });
});
