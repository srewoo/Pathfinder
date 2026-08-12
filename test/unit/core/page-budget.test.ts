/**
 * Per-page exploration budget.
 *
 * The budget used to be a flat 90s while the target cap was 100. At the measured
 * ~2.5s per click that bought ~35 clicks, so the budget always ended exploration
 * first and the cap was decoration — two numbers that silently disagreed. Deriving
 * the budget from the target count is what keeps them consistent.
 */
import { describe, it, expect } from 'vitest';
import { adaptBudget, budgetCeiling, budgetForPage } from '../../../src/core/explorer/explorer-agent';

const PER_TARGET_MS = 2_000;

describe('budgetForPage', () => {
  it('given_a_full_default_page_then_the_budget_covers_every_target', () => {
    // The regression: 100 targets must not be handed a 90s budget.
    const budget = budgetForPage(100, false);
    expect(budget).toBeGreaterThanOrEqual(100 * PER_TARGET_MS);
  });

  it('given_a_full_exhaustive_page_then_the_budget_covers_the_300_cap', () => {
    expect(budgetForPage(300, true)).toBeGreaterThanOrEqual(300 * PER_TARGET_MS);
  });

  it('given_a_small_page_then_the_floor_applies_but_costs_nothing', () => {
    // A budget is a ceiling, not a duration — 3 targets still finish in seconds.
    expect(budgetForPage(3, false)).toBe(240_000);
    expect(budgetForPage(0, false)).toBe(240_000);
  });

  it('given_an_absurd_target_count_then_the_ceiling_bounds_it', () => {
    // One pathological page must not own the whole run.
    expect(budgetForPage(100_000, false)).toBe(480_000);
    expect(budgetForPage(100_000, true)).toBe(900_000);
  });

  it('given_exhaustive_mode_then_it_never_gets_less_than_the_default_page', () => {
    for (const n of [0, 10, 100, 300, 1000]) {
      expect(budgetForPage(n, true), `n=${n}`).toBeGreaterThanOrEqual(budgetForPage(n, false));
    }
  });

  it('given_more_targets_then_the_budget_never_shrinks', () => {
    let prev = 0;
    for (const n of [0, 1, 50, 100, 200, 240, 300, 500]) {
      const b = budgetForPage(n, true);
      expect(b, `n=${n}`).toBeGreaterThanOrEqual(prev);
      prev = b;
    }
  });
});

describe('adaptBudget — measured cost beats a constant', () => {
  /**
   * `PER_TARGET_BUDGET_MS` is a starting guess. On a real heavy SPA it was wrong by
   * almost 6×: a run averaged 11.7s per target and stopped with 13 of 54 targets
   * untried, while the ceiling still had minutes of headroom. These tests pin the
   * behaviour that uses that headroom.
   */
  it('given_clicks_far_slower_than_estimated_then_the_budget_grows', () => {
    // The measured case: 41 clicks in 480s on 54 targets.
    const grown = adaptBudget(480_000, 480_000, 41, 54, true);
    expect(grown).toBeGreaterThan(480_000);
    // Enough for the remaining 13 at the observed rate.
    expect(grown).toBeGreaterThanOrEqual(54 * (480_000 / 41));
  });

  it('given_the_projection_exceeding_the_ceiling_then_the_ceiling_wins', () => {
    // One pathological page must not own the entire run.
    expect(adaptBudget(480_000, 600_000, 5, 300, true)).toBe(budgetCeiling(true));
    expect(adaptBudget(240_000, 600_000, 5, 300, false)).toBe(budgetCeiling(false));
  });

  it('given_fast_clicks_then_the_budget_is_never_cut', () => {
    // A page that started slowly must not lose its budget because a few quick
    // clicks pulled the average down.
    expect(adaptBudget(480_000, 2_000, 10, 20, true)).toBe(480_000);
  });

  it('given_too_few_samples_then_nothing_is_inferred', () => {
    // One slow click (a cold cache, a redirect) says nothing about the page.
    expect(adaptBudget(240_000, 30_000, 1, 50, false)).toBe(240_000);
    expect(adaptBudget(240_000, 60_000, 2, 50, false)).toBe(240_000);
  });

  it('given_a_moderately_slow_page_then_the_extension_is_proportionate', () => {
    // 8s/target over 40 targets → 320s of work, 368s with headroom: above the 240s
    // floor and still well under the 480s ceiling, rather than jumping straight to it.
    const grown = adaptBudget(240_000, 80_000, 10, 40, false);
    expect(grown).toBeGreaterThan(240_000);
    expect(grown).toBeLessThan(budgetCeiling(false));
  });

  it('given_a_rate_that_projects_UNDER_the_floor_then_the_floor_stands', () => {
    // 5s/target over 40 targets is ~230s of work — less than the 240s floor, so
    // there is nothing to extend. The floor is not a target to be spent.
    expect(adaptBudget(240_000, 50_000, 10, 40, false)).toBe(240_000);
  });
});
