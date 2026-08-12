/**
 * Clickable rows — how a list page reaches a record's detail page.
 *
 * Measured on a live employee list: 50 rows, every row `cursor: pointer`, 9 cells
 * each inheriting that cursor, and **zero** `<a href>` anywhere in them. So:
 *
 *   - the destination is reachable only by clicking (no href to enqueue), and
 *   - a naive reading sees 450 targets that are really 50, nine of which lead to
 *     the same place.
 *
 * One target per row, three rows per page, and the skipped remainder counted.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { detectRowNavigationTargets } from '../../../src/content/element-detector';
import { partitionExplorationTargets } from '../../../src/core/explorer/page-scanner';
import type { InteractiveElement } from '../../../src/storage/schemas';

/** A grid in the shape the real app renders — rows clickable, cells inheriting. */
function mountGrid(rowCount: number, opts: { pointer?: boolean; withHeader?: boolean } = {}): void {
  const { pointer = true, withHeader = false } = opts;
  const header = withHeader
    ? `<div role="row"><div role="columnheader">Id</div><div role="columnheader">Name</div></div>`
    : '';
  const rows = Array.from({ length: rowCount }, (_, i) => `
    <div role="row" style="cursor:${pointer ? 'pointer' : 'auto'}">
      <div role="cell"><input type="checkbox"></div>
      <div role="cell"><div>${1000 + i}</div></div>
      <div role="cell"><div>Employee ${i}</div></div>
      <div role="cell" class="actions"><button><i class="oxd-icon bi-trash"></i></button></div>
    </div>`).join('');
  document.body.innerHTML = `<div role="table">${header}${rows}</div>`;
}

/** jsdom reports no geometry; the detector requires a non-zero box. */
beforeEach(() => {
  document.body.innerHTML = '';
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return { x: 0, y: 10, top: 10, bottom: 30, left: 0, right: 120, width: 120, height: 20, toJSON: () => ({}) } as DOMRect;
  };
});

describe('detectRowNavigationTargets', () => {
  it('given_a_grid_of_clickable_rows_then_ONE_target_per_row', () => {
    // The 450-vs-50 correction.
    mountGrid(5);
    const targets = detectRowNavigationTargets();
    expect(targets).toHaveLength(5);
    expect(targets.every((t) => t.rowNavigation === true)).toBe(true);
  });

  it('given_a_row_then_the_target_cell_holds_no_control', () => {
    // Otherwise the click lands on the row's checkbox or its delete button.
    mountGrid(1);
    const [target] = detectRowNavigationTargets();
    expect(target.text).toBe('1000');
    expect(target.text).not.toContain('Employee');
  });

  it('given_rows_that_are_NOT_clickable_then_nothing_is_emitted', () => {
    // A plain data table is not a navigation surface; treating it as one would
    // spend the page budget clicking text.
    mountGrid(5, { pointer: false });
    expect(detectRowNavigationTargets()).toEqual([]);
  });

  it('given_a_header_row_then_it_is_skipped', () => {
    // Clicking a header sorts. That is a different interaction, and the header is
    // already reachable as an ordinary control.
    mountGrid(2, { withHeader: true });
    const targets = detectRowNavigationTargets();
    expect(targets).toHaveLength(2);
    expect(targets.some((t) => t.text === 'Id')).toBe(false);
  });

  it('given_a_huge_grid_then_candidates_are_bounded', () => {
    mountGrid(200);
    expect(detectRowNavigationTargets().length).toBeLessThanOrEqual(25);
  });

  it('given_rows_then_targets_are_marked_as_being_in_a_data_region', () => {
    mountGrid(2);
    expect(detectRowNavigationTargets().every((t) => t.inDataRegion)).toBe(true);
  });
});

describe('row navigations are sampled, not exhausted', () => {
  const rowTarget = (i: number): InteractiveElement =>
    ({ selector: `#row-${i}`, tag: 'div', role: 'button', rowNavigation: true, inDataRegion: true,
       text: `${1000 + i}`, visible: true, position: { x: 0, y: 0, width: 100, height: 20 } }) as InteractiveElement;

  it('given_50_clickable_rows_then_only_3_are_clicked_and_the_rest_are_counted', () => {
    const p = partitionExplorationTargets(Array.from({ length: 50 }, (_, i) => rowTarget(i)), new Set());
    expect(p.targets).toHaveLength(3);
    expect(p.rowNavigationsSkipped).toBe(47);
  });

  it('given_a_row_navigation_then_it_ranks_ahead_of_ordinary_buttons', () => {
    // On a list page the record behind a row is usually the most valuable thing
    // on screen, and nothing else can reach it.
    const button = { selector: '#save', tag: 'button', text: 'Save', visible: true,
      position: { x: 0, y: 0, width: 10, height: 10 } } as InteractiveElement;
    const out = partitionExplorationTargets([button, rowTarget(0)], new Set()).targets.map((t) => t.selector);
    expect(out.indexOf('#row-0')).toBeLessThan(out.indexOf('#save'));
  });

  it('given_fewer_rows_than_the_cap_then_nothing_is_reported_skipped', () => {
    const p = partitionExplorationTargets([rowTarget(0), rowTarget(1)], new Set());
    expect(p.targets).toHaveLength(2);
    expect(p.rowNavigationsSkipped).toBe(0);
  });

  it('given_row_targets_and_normal_targets_then_the_cap_applies_only_to_rows', () => {
    const buttons = Array.from({ length: 6 }, (_, i) =>
      ({ selector: `#b${i}`, tag: 'button', text: `Button ${i}`, visible: true,
         position: { x: 0, y: 0, width: 10, height: 10 } }) as InteractiveElement);
    const rows = Array.from({ length: 10 }, (_, i) => rowTarget(i));
    const p = partitionExplorationTargets([...buttons, ...rows], new Set());
    expect(p.targets.filter((t) => t.rowNavigation)).toHaveLength(3);
    expect(p.targets.filter((t) => !t.rowNavigation)).toHaveLength(6);
  });
});
