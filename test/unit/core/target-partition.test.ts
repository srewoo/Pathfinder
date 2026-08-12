/**
 * Click-target selection: what gets clicked, what is withheld, and what is said
 * about the difference.
 *
 * Two measured failures are pinned here:
 *
 *   1. A live app had 118 dropdowns and ZERO native `<select>` elements. Every one
 *      was `<div tabindex="0">`, which the click set rejected — so no filter and no
 *      dropdown anywhere in the application could be opened.
 *   2. Withheld controls were dropped silently, so a page where 50 deletes were
 *      skipped reported the same coverage as a page that had none.
 */
import { describe, it, expect } from 'vitest';
import { partitionExplorationTargets, selectExplorationTargets } from '../../../src/core/explorer/page-scanner';
import type { InteractiveElement } from '../../../src/storage/schemas';

const el = (over: Partial<InteractiveElement> = {}): InteractiveElement =>
  ({ selector: '#x', tag: 'button', visible: true, position: { x: 0, y: 0, width: 30, height: 30 }, ...over }) as InteractiveElement;

const sels = (list: InteractiveElement[]): string[] => list.map((e) => e.selector);

describe('focusable custom widgets', () => {
  it('given_a_div_with_tabindex_0_then_it_IS_a_click_target', () => {
    // <div class="oxd-select-text-input" tabindex="0">-- Select --</div>
    const dropdown = el({ selector: '#role', tag: 'div', tabIndex: 0, text: '-- Select --' });
    expect(sels(selectExplorationTargets([dropdown], new Set()))).toEqual(['#role']);
  });

  it('given_tabindex_minus_1_then_it_is_not_a_target', () => {
    // Programmatic focus only — not a user-facing control.
    const skipped = el({ selector: '#skip', tag: 'div', tabIndex: -1, text: 'x' });
    expect(selectExplorationTargets([skipped], new Set())).toEqual([]);
  });

  it('given_a_focusable_form_input_then_it_stays_out_of_the_CLICK_set', () => {
    // Inputs are filled by the form path; clicking them discovers nothing.
    const input = el({ selector: '#q', tag: 'input', type: 'text', tabIndex: 0 });
    expect(selectExplorationTargets([input], new Set())).toEqual([]);
  });

  it('given_a_dropdown_and_a_stray_pointer_div_then_the_dropdown_is_clicked_first', () => {
    // Opening a dropdown reveals its options — a larger discovery than a stray div.
    const stray = el({ selector: '#stray', tag: 'div', role: 'button', text: 'hmm' });
    const dropdown = el({ selector: '#status', tag: 'div', tabIndex: 0, text: '-- Select --' });
    const out = sels(selectExplorationTargets([stray, dropdown], new Set()));
    expect(out.indexOf('#status')).toBeLessThan(out.indexOf('#stray'));
  });
});

describe('withheld controls are accounted for', () => {
  const page = (): InteractiveElement[] => [
    el({ selector: '#add', text: 'Add' }),
    el({ selector: '#del1', text: '', iconClasses: ['oxd-icon', 'bi-trash'], inDataRegion: true }),
    el({ selector: '#del2', text: '', iconClasses: ['oxd-icon', 'bi-trash'], inDataRegion: true }),
    el({ selector: '#edit1', text: '', iconClasses: ['oxd-icon', 'bi-pencil-fill'], inDataRegion: true }),
    el({ selector: '#mystery', text: '', iconClasses: ['oxd-icon', 'bi-three-dots'], inDataRegion: true }),
  ];

  it('given_icon_only_deletes_then_they_are_withheld_and_REPORTED', () => {
    const p = partitionExplorationTargets(page(), new Set());
    expect(sels(p.destructive)).toEqual(['#del1', '#del2']);
    expect(sels(p.unidentified)).toEqual(['#mystery']);
    expect(sels(p.targets)).toEqual(['#add', '#edit1']);
  });

  it('given_includeDangerous_then_nothing_is_withheld', () => {
    const p = partitionExplorationTargets(page(), new Set(), { includeDangerous: true });
    expect(p.destructive).toEqual([]);
    expect(p.unidentified).toEqual([]);
    expect(p.targets).toHaveLength(5);
  });

  it('given_more_targets_than_the_cap_then_the_shortfall_is_counted', () => {
    // Silent truncation reads as complete coverage.
    const many = Array.from({ length: 12 }, (_, i) => el({ selector: `#b${i}`, text: `Button ${i}` }));
    const p = partitionExplorationTargets(many, new Set(), { maxTargets: 5 });
    expect(p.targets).toHaveLength(5);
    expect(p.overCap).toBe(7);
  });

  it('given_everything_fits_then_overCap_is_zero', () => {
    expect(partitionExplorationTargets(page(), new Set()).overCap).toBe(0);
  });
});

describe('existing behaviour is preserved', () => {
  it('given_visited_selectors_then_they_are_skipped', () => {
    const items = [el({ selector: '#a', text: 'A' }), el({ selector: '#b', text: 'B' })];
    expect(sels(selectExplorationTargets(items, new Set(['#a'])))).toEqual(['#b']);
  });

  it('given_nav_links_and_buttons_then_navigation_is_explored_first', () => {
    const link = el({ selector: '#nav', tag: 'a', text: 'Settings' });
    const button = el({ selector: '#act', tag: 'button', text: 'Save' });
    expect(sels(selectExplorationTargets([button, link], new Set()))).toEqual(['#nav', '#act']);
  });

  it('given_off_viewport_elements_then_they_are_kept_but_ranked_last', () => {
    const off = el({ selector: '#off', text: 'Below fold', visible: false });
    const on = el({ selector: '#on', text: 'On screen', visible: true });
    expect(sels(selectExplorationTargets([off, on], new Set()))).toEqual(['#on', '#off']);
  });

  it('given_a_disabled_control_then_it_is_skipped', () => {
    expect(selectExplorationTargets([el({ selector: '#d', text: 'Save', disabled: true })], new Set())).toEqual([]);
  });
});

describe('session-ending controls are withheld from every path', () => {
  const logout = (over: Partial<InteractiveElement> = {}): InteractiveElement =>
    el({ selector: '#logout', text: 'Logout', ...over });

  it('given_a_logout_control_then_it_is_never_a_target', () => {
    const p = partitionExplorationTargets([el({ selector: '#save', text: 'Save' }), logout()], new Set());
    expect(sels(p.targets)).toEqual(['#save']);
    expect(sels(p.sessionEnding)).toEqual(['#logout']);
  });

  it('given_includeDangerous_then_deletes_open_but_logout_does_NOT', () => {
    // The distinction that matters: the escape hatch is about data, not about
    // staying signed in. A logged-out crawler maps the login page while the run
    // keeps counting pages as explored.
    const del = el({ selector: '#del', text: '', iconClasses: ['bi-trash'], inDataRegion: true });
    const p = partitionExplorationTargets([del, logout()], new Set(), { includeDangerous: true });
    expect(sels(p.targets)).toEqual(['#del']);
    expect(sels(p.sessionEnding)).toEqual(['#logout']);
  });

  it('given_an_icon_only_logout_link_then_its_href_still_withholds_it', () => {
    // The user-menu case: <a href="/logout"><i class="oxd-icon"></i></a>
    const iconLink = el({ selector: '#out', tag: 'a', text: '', href: 'https://app.test/logout' });
    const p = partitionExplorationTargets([iconLink], new Set(), { includeDangerous: true });
    expect(sels(p.sessionEnding)).toEqual(['#out']);
    expect(p.targets).toEqual([]);
  });
});
