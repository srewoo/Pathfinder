/**
 * Bulk-action discovery.
 *
 * The behaviour under test is a trade: exploration touches selection controls it
 * previously refused to touch, in exchange for finding a class of UI it could not
 * see. The guardrails are what make that trade acceptable, so they are what these
 * tests pin down:
 *
 *   - a revealed "Delete selected" is RECORDED and never clicked
 *   - every toggle is put back, and a failed reset is reported, not assumed away
 *   - settings toggles (which persist on change) stay behind the mutation gate
 */
import { describe, it, expect, vi } from 'vitest';
import { probeSelectionActions } from '../../../src/core/explorer/selection-explorer';
import { selectToggleTargets } from '../../../src/core/explorer/page-scanner';
import type { InteractiveElement, PageAction } from '../../../src/storage/schemas';

const checkbox = (over: Partial<InteractiveElement> = {}): InteractiveElement =>
  ({
    selector: '#row-1-select',
    tag: 'input',
    type: 'checkbox',
    ariaLabel: 'Select row',
    inDataRegion: true,
    visible: true,
    position: { x: 0, y: 0, width: 16, height: 16 },
    ...over,
  }) as InteractiveElement;

const action = (label: string, selector = `#${label.toLowerCase()}`): PageAction => ({
  selector,
  label,
  tag: 'button',
  kind: 'action',
});

/**
 * A page whose available actions depend on whether anything is selected —
 * the shape of every list view with a bulk-action toolbar.
 */
function selectablePage(revealed: PageAction[], opts: { resetWorks?: boolean } = {}) {
  const { resetWorks = true } = opts;
  const base = [action('Filters'), action('Newest first')];
  let selected = false;
  const clicks: string[] = [];

  return {
    clicks,
    isSelected: () => selected,
    deps: {
      click: vi.fn(async (selector: string) => {
        clicks.push(selector);
        if (selector.endsWith('-select')) {
          // A page whose reset is broken stays selected once selected.
          if (selected && !resetWorks) return;
          selected = !selected;
        }
      }),
      scanActions: vi.fn(async () => (selected ? [...base, ...revealed] : [...base])),
      settle: vi.fn(async () => undefined),
    },
  };
}

describe('probeSelectionActions', () => {
  it('given_a_row_checkbox_that_reveals_a_toolbar_then_the_actions_are_recorded', async () => {
    const page = selectablePage([action('Export'), action('Move to library')]);

    const found = await probeSelectionActions([checkbox()], new Set(), page.deps);

    expect(found).toHaveLength(1);
    expect(found[0].revealedActions.map((a) => a.label)).toEqual(['Export', 'Move to library']);
    expect(found[0].triggerLabel).toBe('Select row');
  });

  it('given_a_revealed_DELETE_action_then_it_is_recorded_but_NEVER_clicked', async () => {
    // The headline safety property. Discovering the control is the value;
    // pressing it would destroy the user's data.
    const page = selectablePage([action('Delete selected', '#bulk-delete')]);

    const found = await probeSelectionActions([checkbox()], new Set(), page.deps);

    expect(found[0].revealedActions.map((a) => a.label)).toContain('Delete selected');
    expect(page.clicks).not.toContain('#bulk-delete');
    // Only the toggle itself was touched: select, then deselect.
    expect(page.clicks).toEqual(['#row-1-select', '#row-1-select']);
  });

  it('given_a_successful_probe_then_the_page_is_left_unselected', async () => {
    const page = selectablePage([action('Export')]);
    await probeSelectionActions([checkbox()], new Set(), page.deps);

    expect(page.isSelected()).toBe(false);
    expect(page.clicks.filter((c) => c === '#row-1-select')).toHaveLength(2);
  });

  it('given_a_reset_that_does_not_take_then_resetOk_is_false', async () => {
    // Reported rather than assumed: rows left selected change what every later
    // step on this page does, and the reader has to be able to see that.
    const page = selectablePage([action('Export')], { resetWorks: false });

    const found = await probeSelectionActions([checkbox()], new Set(), page.deps);

    expect(found[0].resetOk).toBe(false);
    expect(page.isSelected()).toBe(true);
  });

  it('given_a_checkbox_that_reveals_nothing_then_nothing_is_recorded_but_it_is_still_reset', async () => {
    const page = selectablePage([]);

    const found = await probeSelectionActions([checkbox()], new Set(), page.deps);

    expect(found).toEqual([]);
    expect(page.isSelected()).toBe(false);
  });

  it('given_a_toggle_that_cannot_be_clicked_then_the_probe_continues_without_a_reset', async () => {
    // Virtualized rows unmount. Nothing changed, so nothing needs undoing —
    // and one gone row must not abort discovery on the rest of the page.
    const page = selectablePage([action('Export')]);
    page.deps.click.mockImplementationOnce(async () => {
      throw new Error('element not found: #row-1-select');
    });

    const found = await probeSelectionActions(
      [checkbox(), checkbox({ selector: '#row-2-select' })],
      new Set(),
      page.deps
    );

    expect(found.map((f) => f.triggerSelector)).toEqual(['#row-2-select']);
  });

  it('given_an_already_visited_toggle_then_it_is_not_probed_again', async () => {
    const page = selectablePage([action('Export')]);
    const visited = new Set(['#row-1-select']);

    const found = await probeSelectionActions([checkbox()], visited, page.deps);

    expect(found).toEqual([]);
    expect(page.clicks).toEqual([]);
  });

  it('given_a_probed_toggle_then_it_is_marked_visited_so_the_click_phase_skips_it', async () => {
    const visited = new Set<string>();
    await probeSelectionActions([checkbox()], visited, selectablePage([action('Export')]).deps);
    expect(visited.has('#row-1-select')).toBe(true);
  });
});

describe('selectToggleTargets', () => {
  it('given_a_row_checkbox_then_it_is_a_target', () => {
    expect(selectToggleTargets([checkbox()], new Set())).toHaveLength(1);
  });

  it('given_a_settings_toggle_then_it_is_EXCLUDED_by_default', () => {
    // Outside a data region, a switch usually persists immediately
    // (PATCH /preferences). Discovering bulk actions must not rewrite the
    // user's account settings as a side effect.
    const settings = checkbox({
      selector: '#notify',
      role: 'switch',
      inDataRegion: false,
      ariaLabel: 'Email me about new recordings',
    });
    expect(selectToggleTargets([settings], new Set())).toEqual([]);
    expect(selectToggleTargets([settings], new Set(), { includeSettingsToggles: true })).toHaveLength(1);
  });

  it('given_a_select_all_and_a_row_checkbox_then_the_ROW_is_probed_first', () => {
    // One row reveals the same toolbar; "select all" on a 4,000-row grid is a
    // far riskier state to be left in if the reset ever fails.
    const all = checkbox({ selector: '#select-all', ariaLabel: 'Select all rows' });
    const row = checkbox({ selector: '#row-7' });

    const targets = selectToggleTargets([all, row], new Set(), { maxTargets: 2 });
    expect(targets.map((t) => t.selector)).toEqual(['#row-7', '#select-all']);
  });

  it('given_a_disabled_toggle_then_it_is_skipped', () => {
    expect(selectToggleTargets([checkbox({ disabled: true })], new Set())).toEqual([]);
  });

  it('given_a_text_input_or_a_button_then_neither_is_a_toggle_target', () => {
    const text = checkbox({ selector: '#q', type: 'search' });
    const button = { selector: '#go', tag: 'button', visible: true } as InteractiveElement;
    expect(selectToggleTargets([text, button], new Set())).toEqual([]);
  });

  it('given_many_row_checkboxes_then_only_a_bounded_number_are_probed', () => {
    // A 4,000-row grid must not become 4,000 click pairs.
    const rows = Array.from({ length: 50 }, (_, i) => checkbox({ selector: `#row-${i}` }));
    expect(selectToggleTargets(rows, new Set())).toHaveLength(5);
    expect(selectToggleTargets(rows, new Set(), { maxTargets: 2 })).toHaveLength(2);
  });
});
