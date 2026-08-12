/**
 * The reveal sweep, against a genuinely virtualized list.
 *
 * Two defects are pinned here, both of which silently corrupted coverage on any
 * long list — which is most of the pages in a real app:
 *
 *   1. Only ONE scan happened, after the sweep. A windowed list (react-window,
 *      ag-grid) mounts only the rows in view, so a single scan saw a single
 *      window and the rest of the list was never discovered.
 *   2. The sweep restored `window.scrollTo(0)` but left inner scroll containers
 *      at the bottom. The caller's own scan then read a grid scrolled to its end
 *      — so it mapped the tail of the list while the user was looking at the head.
 *
 * jsdom has no layout engine, so geometry and scroll behaviour are supplied
 * explicitly below. That is the point of the harness: the virtualization is real
 * (rows mount and unmount as scrollTop changes), only the layout is faked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { revealPageContent } from '../../../src/content/element-detector';

const ROWS_PER_WINDOW = 3;
const WINDOW_HEIGHT = 300;
const TOTAL_HEIGHT = 3000;

let restoreRect: (() => void) | null = null;

/**
 * A scroll container that mounts only the rows for its current scroll offset —
 * the defining behaviour of a virtualized list.
 */
function mountVirtualizedList(): HTMLElement {
  const container = document.createElement('div');
  container.style.overflowY = 'auto';
  document.body.appendChild(container);

  let scrollTop = 0;
  const render = (): void => {
    const windowIndex = Math.floor(scrollTop / WINDOW_HEIGHT);
    container.innerHTML = '';
    for (let i = 0; i < ROWS_PER_WINDOW; i++) {
      const row = windowIndex * ROWS_PER_WINDOW + i;
      const btn = document.createElement('button');
      btn.id = `row-${row}`;
      btn.textContent = `Row ${row}`;
      container.appendChild(btn);
    }
  };

  // jsdom reports 0 for every layout property and null for offsetParent, so the
  // container would fail the "is this scrollable" heuristic on a technicality.
  Object.defineProperties(container, {
    offsetParent: { get: () => document.body },
    clientHeight: { get: () => WINDOW_HEIGHT },
    scrollHeight: { get: () => TOTAL_HEIGHT },
    scrollTop: {
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
        render();
      },
    },
  });

  render();
  return container;
}

/** Window index a row id belongs to. */
const windowOf = (selector: string): number =>
  Math.floor(Number(selector.replace(/\D/g, '')) / ROWS_PER_WINDOW);

beforeEach(() => {
  document.body.innerHTML = '';
  // Every element gets a non-zero, in-viewport box so the detector considers it
  // rendered. Without this jsdom reports 0×0 and nothing is ever detected.
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return { x: 0, y: 10, top: 10, bottom: 30, left: 0, right: 100, width: 100, height: 20, toJSON: () => ({}) } as DOMRect;
  };
  restoreRect = () => {
    Element.prototype.getBoundingClientRect = original;
  };
  // jsdom does not implement scrolling; the sweep only needs the call to succeed.
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
});

afterEach(() => {
  restoreRect?.();
  restoreRect = null;
});

describe('revealPageContent over a virtualized list', () => {
  it('given_rows_that_mount_per_scroll_window_then_the_union_spans_MANY_windows', async () => {
    // The regression: with one post-sweep scan this returned a single window's
    // worth of rows out of ten.
    mountVirtualizedList();

    const revealed = await revealPageContent();
    const windows = new Set(
      revealed.filter((el) => el.selector.includes('row-')).map((el) => windowOf(el.selector))
    );

    expect(windows.size).toBeGreaterThan(5);
    // The head of the list (visible before any scrolling) must survive too — it
    // is what the user is actually looking at.
    expect(windows.has(0)).toBe(true);
  }, 15_000);

  it('given_the_sweep_finishes_then_inner_containers_are_returned_to_the_top', async () => {
    // If this regresses, the CALLER's scan reads the end of the list and reports
    // it as the page — the failure is silent and looks like a valid result.
    const container = mountVirtualizedList();

    await revealPageContent();

    expect(container.scrollTop).toBe(0);
    expect(container.querySelector('#row-0')).not.toBeNull();
  }, 15_000);

  it('given_a_static_page_then_the_union_is_just_its_elements_deduped', async () => {
    document.body.innerHTML = `
      <button id="save">Save</button>
      <a id="home" href="/">Home</a>`;

    const revealed = await revealPageContent();
    const selectors = revealed.map((el) => el.selector);

    expect(selectors).toContain('#save');
    expect(selectors).toContain('#home');
    // Scanned at least 11 times across the sweep; each element appears once.
    expect(new Set(selectors).size).toBe(selectors.length);
  }, 15_000);

  it('given_a_row_checkbox_then_it_is_marked_as_being_in_a_data_region', async () => {
    // Drives the safe/unsafe split in selection exploration: a checkbox inside a
    // table selects a row, one outside usually persists a setting.
    document.body.innerHTML = `
      <table><tbody><tr><td><input id="pick" type="checkbox" /></td></tr></tbody></table>
      <input id="notify" type="checkbox" />`;

    const revealed = await revealPageContent();
    const pick = revealed.find((el) => el.selector === '#pick');
    const notify = revealed.find((el) => el.selector === '#notify');

    expect(pick?.inDataRegion).toBe(true);
    expect(notify?.inDataRegion).toBeUndefined();
  }, 15_000);
});

describe('the sweep closes what its hovering opened', () => {
  /**
   * The sweep hovers every nav item and every `aria-expanded="false"` control to
   * see inside them, and it used to leave them all open — a stack of flyouts
   * covering the page for the rest of the run. Everything underneath then failed
   * its hit test as "obscured", so the caller burned a click timeout per element
   * and clicked the menu instead of the control it aimed at.
   */
  beforeEach(() => {
    // jsdom has no hit testing. The edges of a real page are usually empty, which
    // is what findEmptyPoint probes for.
    (document as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => document.body;
  });

  function mountHoverMenu(
    opts: { closesOnHoverOut?: boolean; closesOnEscape?: boolean; closesOnOutsideClick?: boolean } = {}
  ) {
    const { closesOnHoverOut = false, closesOnEscape = false, closesOnOutsideClick = false } = opts;
    document.body.innerHTML = `
      <nav><div id="trigger" aria-expanded="false">Coaching</div></nav>
      <div id="menu" role="menu" hidden><a href="/a">Recordings</a></div>`;
    const trigger = document.getElementById('trigger') as HTMLElement;
    const menu = document.getElementById('menu') as HTMLElement;
    const open = () => { menu.hidden = false; trigger.setAttribute('aria-expanded', 'true'); };
    const close = () => { menu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); };
    trigger.addEventListener('mouseover', open);
    if (closesOnHoverOut) trigger.addEventListener('mouseout', close);
    if (closesOnEscape) {
      document.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Escape') close();
      });
    }
    if (closesOnOutsideClick) {
      document.addEventListener('click', (e) => { if (e.target !== trigger) close(); });
    }
    return { isOpen: () => !menu.hidden };
  }

  it('given_a_menu_that_closes_on_hover_out_then_the_sweep_closes_it', async () => {
    const m = mountHoverMenu({ closesOnHoverOut: true });
    await revealPageContent();
    expect(m.isOpen()).toBe(false);
  }, 15_000);

  it('given_a_menu_that_only_closes_on_ESCAPE_then_the_sweep_closes_it', async () => {
    const m = mountHoverMenu({ closesOnEscape: true });
    await revealPageContent();
    expect(m.isOpen()).toBe(false);
  }, 15_000);

  it('given_a_menu_that_only_closes_on_an_OUTSIDE_CLICK_then_the_sweep_closes_it', async () => {
    // The stubborn case in the screenshot: hover-out and Escape do nothing.
    const m = mountHoverMenu({ closesOnOutsideClick: true });
    await revealPageContent();
    expect(m.isOpen()).toBe(false);
  }, 15_000);

  it('given_the_menu_contents_then_they_are_still_captured_before_closing', async () => {
    // Closing must not cost coverage — it happens after the final scan.
    mountHoverMenu({ closesOnHoverOut: true });
    const revealed = await revealPageContent();
    // Asserted by the control, not its selector: CSS.escape escapes the slash in
    // the href, so the exact selector string is an implementation detail.
    expect(revealed.some((el) => el.text === 'Recordings')).toBe(true);
  }, 15_000);

  it('given_a_page_with_nothing_open_then_no_stray_click_is_dispatched', async () => {
    // The outside-click is a last resort. On an ordinary page it must not fire —
    // a blind click to dismiss nothing could press a real control.
    document.body.innerHTML = `<button id="save">Save</button>`;
    let clicked = 0;
    document.addEventListener('click', () => { clicked++; });
    await revealPageContent();
    expect(clicked).toBe(0);
  }, 15_000);
});
