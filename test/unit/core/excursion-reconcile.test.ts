/**
 * T08 item 8: a navigation away and back is not automatically lossless.
 *
 * Opening a link-derived in-page view navigates off the page and back. Every
 * target the rest of the pass clicks was chosen from a scan taken BEFORE that,
 * so an SPA that remounts its tree on return leaves the pass clicking at
 * selectors that no longer exist — and the mocked page models cannot show this,
 * because their markup is the same no matter what navigations happen.
 *
 * These tests exercise the comparison directly, so the behaviour is pinned by
 * something other than a fake page that would beg the question.
 */
import { describe, it, expect } from 'vitest';
import { reconcileAfterExcursion } from '../../../src/core/explorer/explorer-agent';
import type { InteractiveElement } from '../../../src/storage/schemas';

function el(selector: string): InteractiveElement {
  return { selector, tag: 'button', text: selector, visible: true, disabled: false } as InteractiveElement;
}

describe('the page after the excursion is what the pass acts on', () => {
  it('given_the_page_remounts_with_new_selectors_then_the_fresh_scan_wins', () => {
    const result = reconcileAfterExcursion({
      before: [el('#a'), el('#b')],
      after: [el('#a-2'), el('#b-2')],
    });

    expect(result.elements.map((e) => e.selector)).toEqual(['#a-2', '#b-2']);
  });

  it('given_the_page_remounts_then_the_lost_selectors_are_named', () => {
    const result = reconcileAfterExcursion({
      before: [el('#a'), el('#b')],
      after: [el('#a')],
    });

    expect(result.lost).toEqual(['#b']);
    expect(result.changed).toBe(true);
  });

  it('given_the_page_returns_exactly_as_it_was_then_nothing_is_reported_as_changed', () => {
    const result = reconcileAfterExcursion({
      before: [el('#a'), el('#b')],
      after: [el('#a'), el('#b')],
    });

    expect(result.changed).toBe(false);
    expect(result.lost).toEqual([]);
  });

  // A page can gain elements on return without losing any — a list that
  // finished loading, say. That is still a different page than the one the
  // targets were chosen from.
  it('given_the_page_gains_elements_then_it_counts_as_changed', () => {
    const result = reconcileAfterExcursion({
      before: [el('#a')],
      after: [el('#a'), el('#new')],
    });

    expect(result.changed).toBe(true);
    expect(result.lost).toEqual([]);
    expect(result.elements).toHaveLength(2);
  });
});

describe('a failed re-scan is not mistaken for an empty page', () => {
  // The scan can fail, or run before the page has finished remounting. Treating
  // that as "the page is empty" would discard every target and silently end the
  // pass — worse than acting on a view that might be slightly stale.
  it('given_the_rescan_returns_nothing_then_the_pre_excursion_scan_is_kept', () => {
    const before = [el('#a'), el('#b')];

    const result = reconcileAfterExcursion({ before, after: [] });

    expect(result.elements).toBe(before);
    expect(result.changed).toBe(false);
    expect(result.lost).toEqual([]);
  });

  it('given_both_scans_are_empty_then_the_result_is_empty_and_unchanged', () => {
    const result = reconcileAfterExcursion({ before: [], after: [] });

    expect(result.elements).toEqual([]);
    expect(result.changed).toBe(false);
  });
});
