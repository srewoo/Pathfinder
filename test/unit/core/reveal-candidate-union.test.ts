/**
 * T08 item 6: agent mode must not be able to drop a reveal trigger.
 *
 * The AI's ranked picks replaced the deterministic target list outright, so a
 * `<button>` the model did not happen to name was never clicked — and a form
 * that exists only after that click was never captured. On the measured login
 * page that is the entire test: "Sign in with your username" is a plain button,
 * and everything worth testing is behind it.
 *
 * A ranking model deciding which elements are *interesting* is a fair cost
 * control. Deciding which elements *exist* is not.
 */
import { describe, it, expect } from 'vitest';
import {
  unionWithRevealCandidates,
  MAX_REVEAL_CANDIDATES_ADDED,
} from '../../../src/core/explorer/page-scanner';
import type { InteractiveElement } from '../../../src/storage/schemas';

function el(over: Partial<InteractiveElement> = {}): InteractiveElement {
  return {
    selector: '#btn',
    tag: 'button',
    text: 'Do the thing',
    visible: true,
    disabled: false,
    ...over,
  } as InteractiveElement;
}

/** The shape the click loop actually consumes. */
interface Target {
  selector: string;
  text?: string;
  description?: string;
}

const selectorOf = (t: Target) => t.selector;
const toTarget = (e: InteractiveElement): Target => ({
  selector: e.selector,
  text: e.text || undefined,
  description: `Reveal candidate: ${e.text ?? e.selector}`,
});

function union(ranked: Target[], gated: InteractiveElement[], max?: number) {
  return unionWithRevealCandidates(ranked, gated, selectorOf, toTarget, max);
}

describe('the reveal trigger survives an AI ranking that omits it', () => {
  // The exact failure, as measured.
  it('given_the_ranker_omits_a_button_then_it_is_added_back', () => {
    const result = union(
      [{ selector: '#something-else' }],
      [el({ selector: '#reveal-login', text: 'Sign in with your username' })]
    );

    expect(result.targets.map((t) => t.selector)).toEqual(['#something-else', '#reveal-login']);
    expect(result.added).toBe(1);
  });

  // The model's ordering is its contribution, and its picks should be tried
  // while the page budget is still healthy.
  it('given_a_union_then_the_ranked_picks_keep_their_order_and_come_first', () => {
    const result = union(
      [{ selector: '#a' }, { selector: '#b' }],
      [el({ selector: '#a' }), el({ selector: '#z' })]
    );

    expect(result.targets.map((t) => t.selector)).toEqual(['#a', '#b', '#z']);
  });

  it('given_the_ranker_already_picked_the_button_then_it_is_not_duplicated', () => {
    const result = union([{ selector: '#reveal' }], [el({ selector: '#reveal' })]);

    expect(result.targets).toHaveLength(1);
    expect(result.added).toBe(0);
  });

  it('given_an_added_candidate_then_its_description_says_why_it_was_added', () => {
    const result = union([], [el({ selector: '#reveal', text: 'Show form' })]);
    expect(result.targets[0].description).toMatch(/reveal candidate/i);
  });
});

describe('only stay-on-page controls are added', () => {
  // Links, tabs and menu items navigate or switch view; the explorer already
  // reaches those through its own paths, and adding them back would double the
  // work agent mode exists to avoid.
  it.each([
    ['a link', el({ selector: '#link', tag: 'a' })],
    ['a role=link', el({ selector: '#rl', tag: 'span', role: 'link' })],
    ['a tab', el({ selector: '#tab', tag: 'div', role: 'tab' })],
    ['a menu item', el({ selector: '#mi', tag: 'div', role: 'menuitem' })],
  ])('given_%s_then_it_is_not_added_back', (_name, candidate) => {
    expect(union([], [candidate]).added).toBe(0);
  });

  it.each([
    ['a button element', el({ selector: '#b', tag: 'button' })],
    ['a role=button', el({ selector: '#rb', tag: 'div', role: 'button' })],
  ])('given_%s_then_it_is_added_back', (_name, candidate) => {
    expect(union([], [candidate]).added).toBe(1);
  });
});

describe('safety refusals are inherited, not re-litigated', () => {
  // The candidates come from the already-gated partition, so anything the
  // classifier withheld — a Sign out, a Delete — is simply absent from the
  // input. This pins that the union adds nothing of its own.
  it('given_a_withheld_control_is_absent_from_the_gated_list_then_it_is_never_added', () => {
    const gated = [el({ selector: '#safe' })];
    const result = union([], gated);

    expect(result.targets.map((t) => t.selector)).toEqual(['#safe']);
  });

  it('given_an_empty_gated_list_then_nothing_is_added', () => {
    expect(union([{ selector: '#a' }], []).added).toBe(0);
  });
});

describe('the union is bounded and says when it truncates', () => {
  const many = Array.from({ length: MAX_REVEAL_CANDIDATES_ADDED + 4 }, (_, i) =>
    el({ selector: `#b${i}` })
  );

  // Agent mode exists to keep the per-page cost down; an unbounded union would
  // defeat it.
  it('given_more_candidates_than_the_cap_then_only_the_cap_is_added', () => {
    const result = union([], many);
    expect(result.added).toBe(MAX_REVEAL_CANDIDATES_ADDED);
  });

  // A cap that drops candidates has to report the shortfall, or a page with
  // many buttons looks fully explored when it was not.
  it('given_the_cap_is_reached_then_the_shortfall_is_reported', () => {
    expect(union([], many).omitted).toBe(4);
  });

  it('given_fewer_candidates_than_the_cap_then_nothing_is_omitted', () => {
    expect(union([], [el()]).omitted).toBe(0);
  });

  it('given_an_explicit_cap_then_it_is_respected', () => {
    const result = union([], many, 2);
    expect(result.added).toBe(2);
    expect(result.omitted).toBe(many.length - 2);
  });

  // The whole point of bounding it: the total stays predictable.
  it('given_a_cap_then_the_target_count_never_exceeds_ranked_plus_the_cap', () => {
    const ranked = [{ selector: '#r1' }, { selector: '#r2' }];
    const result = union(ranked, many);
    expect(result.targets.length).toBeLessThanOrEqual(ranked.length + MAX_REVEAL_CANDIDATES_ADDED);
  });
});
