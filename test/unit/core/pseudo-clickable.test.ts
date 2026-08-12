/**
 * Non-semantic clickables.
 *
 * Two measured gaps drive these cases:
 *
 *   - The tag list was div/span/li/td. A real app ships its "Forgot your
 *     password?" link as `<p class="oxd-text">`, which was therefore invisible.
 *   - The rule required 1–60 characters of text, which excluded every icon-only
 *     control by construction — 590 of them across 49 pages, including the row
 *     edit and delete buttons on every list page.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { iconClassesOf, isPseudoClickable } from '../../../src/content/element-detector';

/** jsdom computes no styles from stylesheets, so cursor is set inline. */
function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('tags that design systems use as controls', () => {
  it('given_a_clickable_p_then_it_is_a_pseudo_clickable', () => {
    // The real login-page markup that was invisible.
    const el = mount(`<p class="oxd-text oxd-text--p" style="cursor:pointer">Forgot your password?</p>`);
    expect(isPseudoClickable(el)).toBe(true);
  });

  it('given_clickable_headings_and_labels_then_they_qualify', () => {
    expect(isPseudoClickable(mount(`<h3 style="cursor:pointer">Expand section</h3>`))).toBe(true);
    expect(isPseudoClickable(mount(`<label style="cursor:pointer">Pick me</label>`))).toBe(true);
  });

  it('given_a_non_clickable_p_then_it_does_NOT_qualify', () => {
    // Widening the tag list must not turn body copy into click targets.
    expect(isPseudoClickable(mount(`<p>Just some prose.</p>`))).toBe(false);
  });

  it('given_a_tag_outside_the_list_then_it_does_not_qualify', () => {
    expect(isPseudoClickable(mount(`<section style="cursor:pointer">x</section>`))).toBe(false);
  });
});

describe('icon-only controls', () => {
  it('given_a_bare_icon_with_a_pointer_cursor_then_it_qualifies_despite_having_no_text', () => {
    expect(isPseudoClickable(mount(`<i class="oxd-icon bi-three-dots" style="cursor:pointer"></i>`))).toBe(true);
  });

  it('given_a_text_free_element_with_an_aria_label_then_it_qualifies', () => {
    expect(isPseudoClickable(mount(`<span aria-label="Close panel" style="cursor:pointer"></span>`))).toBe(true);
  });

  it('given_an_empty_div_with_no_icon_name_or_focusability_then_it_does_NOT_qualify', () => {
    // Spacers and decorative overlays often carry a pointer cursor. Without any
    // other signal there is nothing to suggest it is a control.
    expect(isPseudoClickable(mount(`<div style="cursor:pointer"></div>`))).toBe(false);
  });

  it('given_a_focusable_empty_div_then_it_qualifies', () => {
    expect(isPseudoClickable(mount(`<div tabindex="0" style="cursor:pointer"></div>`))).toBe(true);
  });
});

describe('nesting is not double-counted', () => {
  it('given_an_icon_INSIDE_a_button_then_the_icon_does_not_qualify', () => {
    // Clicking the button already covers the icon. Counting both clicked the same
    // control twice and inflated every page inventory by one row per icon.
    mount(`<button><i class="oxd-icon bi-trash" style="cursor:pointer"></i></button>`);
    const icon = document.querySelector('i') as HTMLElement;
    expect(isPseudoClickable(icon)).toBe(false);
  });

  it('given_a_wrapper_around_a_real_control_then_the_wrapper_does_not_qualify', () => {
    const wrapper = mount(`<div style="cursor:pointer"><a href="/x">Go</a></div>`);
    expect(isPseudoClickable(wrapper)).toBe(false);
  });

  it('given_a_long_text_container_then_it_does_not_qualify', () => {
    expect(isPseudoClickable(mount(`<div style="cursor:pointer">${'x'.repeat(80)}</div>`))).toBe(false);
  });
});

describe('iconClassesOf', () => {
  it('given_an_icon_child_then_its_classes_are_collected', () => {
    mount(`<button><i class="oxd-icon bi-trash"></i></button>`);
    const btn = document.querySelector('button') as HTMLElement;
    expect(iconClassesOf(btn)).toContain('bi-trash');
  });

  it('given_library_prefixes_then_each_is_recognised', () => {
    for (const cls of ['fa-trash', 'mdi-delete', 'glyphicon-remove', 'bi-pencil-fill']) {
      mount(`<button><i class="${cls}"></i></button>`);
      const btn = document.querySelector('button') as HTMLElement;
      expect(iconClassesOf(btn), cls).toContain(cls);
    }
  });

  it('given_no_icons_then_the_list_is_empty', () => {
    mount(`<button>Save</button>`);
    expect(iconClassesOf(document.querySelector('button') as HTMLElement)).toEqual([]);
  });

  it('given_many_icons_then_the_list_is_bounded', () => {
    const icons = Array.from({ length: 30 }, (_, i) => `<i class="bi-icon-${i}"></i>`).join('');
    mount(`<div>${icons}</div>`);
    expect(iconClassesOf(document.querySelector('div') as HTMLElement).length).toBeLessThanOrEqual(8);
  });
});
