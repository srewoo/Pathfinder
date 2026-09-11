import { describe, it, expect } from 'vitest';
import { shouldSkipUnchanged } from '../../../src/core/explorer/explorer-agent';

const HASH = 'abc123';

type Args = Parameters<typeof shouldSkipUnchanged>[0];

/** An interior page of a fresh run whose structure matched — the skip case. */
function args(over: Partial<Args> = {}): Args {
  return {
    fresh: true,
    reexplorePage: false,
    isStartPage: false,
    priorStructureHash: HASH,
    structureHash: HASH,
    priorInteractionComplete: true,
    ...over,
  };
}

describe('shouldSkipUnchanged', () => {
  it('given_a_fresh_run_and_an_unchanged_interior_page_then_interaction_is_skipped', () => {
    expect(shouldSkipUnchanged(args())).toBe(true);
  });

  it('given_a_changed_structure_then_it_does_not_skip', () => {
    expect(shouldSkipUnchanged(args({ structureHash: 'different' }))).toBe(false);
  });

  it('given_no_prior_hash_then_it_does_not_skip', () => {
    expect(shouldSkipUnchanged(args({ priorStructureHash: undefined }))).toBe(false);
  });

  // Two pages that both failed to fingerprint must not be treated as identical.
  it('given_an_empty_prior_hash_then_it_does_not_skip', () => {
    expect(shouldSkipUnchanged(args({ priorStructureHash: '', structureHash: '' }))).toBe(false);
  });

  // An incremental run never revisits a mapped page, so it never reaches a
  // fingerprint comparison at all.
  it('given_an_incremental_run_then_it_does_not_skip', () => {
    expect(shouldSkipUnchanged(args({ fresh: false }))).toBe(false);
  });

  // The regression this exists for: a login screen's structure never varies, so
  // it matched its stored fingerprint on every run and was skipped without a
  // single click — which reads as "explore does nothing".
  it('given_the_start_page_then_it_is_never_skipped_even_when_unchanged', () => {
    expect(shouldSkipUnchanged(args({ isStartPage: true }))).toBe(false);
  });

  // The fingerprint is taken from the pre-click scan, so it cannot distinguish a
  // fully-explored page from one whose interaction pass never ran. A page cut
  // short by the page budget would otherwise look settled on every later run.
  it('given_the_prior_pass_never_completed_then_it_does_not_skip', () => {
    expect(shouldSkipUnchanged(args({ priorInteractionComplete: false }))).toBe(false);
  });

  it('given_a_node_from_before_the_flag_existed_then_it_does_not_skip', () => {
    expect(shouldSkipUnchanged(args({ priorInteractionComplete: undefined }))).toBe(false);
  });

  it('given_a_re_explore_then_it_is_never_skipped_even_when_unchanged', () => {
    expect(shouldSkipUnchanged(args({ reexplorePage: true }))).toBe(false);
  });

  it('given_the_start_page_of_a_re_explore_then_it_is_still_not_skipped', () => {
    expect(shouldSkipUnchanged(args({ isStartPage: true, reexplorePage: true }))).toBe(false);
  });
});
