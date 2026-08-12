/**
 * Sampling a control whose design system hides it.
 *
 * Measured on a live app: every checkbox is
 *
 *   <div class="oxd-checkbox-wrapper">
 *     <label><input type="checkbox" style="opacity:0"><span class="oxd-checkbox-input">
 *       <i class="oxd-icon bi-check"></i></span></label></div>
 *
 * The native input keeps a 13×13 box but sits at opacity 0 with the styled span
 * painted over it. It therefore failed BOTH checks — `visible` (opacity 0) and
 * `receivesEvents` (hit-test resolves to the span) — so all 455 checkboxes in the
 * app were unclickable and the bulk-action discovery built for them never fired.
 *
 * The label is not a workaround: a click on a label that owns a control is
 * dispatched to the control by the browser. Clicking it is what a user does.
 *
 * jsdom has no layout, so geometry and the hit-test stack are supplied here. The
 * markup and the opacity are real.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sampleExpr } from '../../../src/drivers/page-scripts';
import type { ElementSample } from '../../../src/core/actionability';

const rects = new WeakMap<Element, DOMRect>();
const rect = (x: number, y: number, w: number, h: number): DOMRect =>
  ({ x, y, top: y, bottom: y + h, left: x, right: x + w, width: w, height: h, toJSON: () => ({}) }) as DOMRect;

let restore: (() => void) | null = null;

/** Elements whose box contains the point, topmost first (paint order = later wins). */
function stackAt(x: number, y: number): Element[] {
  const hits: Element[] = [];
  document.querySelectorAll('*').forEach((el) => {
    const r = rects.get(el);
    if (!r) return;
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) hits.push(el);
  });
  return hits.reverse();
}

beforeEach(() => {
  document.body.innerHTML = '';
  const originalRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return rects.get(this) ?? rect(0, 0, 0, 0);
  };
  (document as unknown as { elementsFromPoint: (x: number, y: number) => Element[] }).elementsFromPoint = stackAt;
  restore = () => {
    Element.prototype.getBoundingClientRect = originalRect;
  };
});

afterEach(() => {
  restore?.();
  restore = null;
});

function sample(ref: string): ElementSample {
  // The production expression, evaluated as the driver would evaluate it. `eval`
  // is the point: the driver ships this string to `Runtime.evaluate`, so running
  // the string is what tests the shipped behaviour. Re-implementing the logic in
  // TypeScript would test a copy and let the real script rot.
  // eslint-disable-next-line no-eval
  return eval(sampleExpr(ref)) as ElementSample;
}

/** The real OrangeHRM checkbox markup. */
function mountHiddenCheckbox(): { input: HTMLInputElement; label: HTMLLabelElement } {
  document.body.innerHTML = `
    <div class="oxd-checkbox-wrapper">
      <label>
        <input data-pf-ref="pf1" type="checkbox" style="opacity:0">
        <span class="oxd-checkbox-input"><i class="oxd-icon bi-check"></i></span>
      </label>
    </div>`;
  const input = document.querySelector('input') as HTMLInputElement;
  const label = document.querySelector('label') as HTMLLabelElement;
  const span = document.querySelector('span') as HTMLElement;
  const icon = document.querySelector('i') as HTMLElement;
  // The input's box is behind the span's, exactly as the app renders it.
  rects.set(input, rect(100, 100, 13, 13));
  rects.set(label, rect(98, 98, 24, 18));
  rects.set(span, rect(100, 99, 18, 18));
  rects.set(icon, rect(101, 100, 16, 16));
  return { input, label };
}

describe('a visually-hidden control proxied by its label', () => {
  it('given_the_real_hidden_checkbox_then_it_becomes_actionable_via_the_label', () => {
    mountHiddenCheckbox();
    const s = sample('pf1');

    expect(s.attached).toBe(true);
    expect(s.visible).toBe(true);
    expect(s.receivesEvents).toBe(true);
    expect(s.proxiedBy).toContain('label');
  });

  it('given_a_proxied_control_then_the_rect_is_the_LABELS_so_the_click_lands', () => {
    // Reporting the label as actionable while dispatching at the hidden input's
    // centre would pass every check and then miss.
    const { label } = mountHiddenCheckbox();
    const s = sample('pf1');
    const lr = label.getBoundingClientRect();
    expect(s.rect).toEqual({ x: lr.left, y: lr.top, width: lr.width, height: lr.height });
  });

  it('given_a_DISABLED_hidden_checkbox_then_enabled_stays_false', () => {
    // Enabled must come from the control, never the proxy — a label is never
    // disabled, so reading it would report a dead control as actionable.
    mountHiddenCheckbox();
    (document.querySelector('input') as HTMLInputElement).disabled = true;
    expect(sample('pf1').enabled).toBe(false);
  });
});

describe('ordinary controls are unaffected', () => {
  it('given_a_normal_visible_checkbox_then_no_proxy_is_used', () => {
    document.body.innerHTML = `<label><input data-pf-ref="pf1" type="checkbox"> Remember me</label>`;
    const input = document.querySelector('input') as HTMLInputElement;
    const label = document.querySelector('label') as HTMLLabelElement;
    rects.set(input, rect(10, 10, 13, 13));
    rects.set(label, rect(10, 10, 120, 20));

    const s = sample('pf1');
    expect(s.visible).toBe(true);
    expect(s.receivesEvents).toBe(true);
    expect(s.proxiedBy).toBeUndefined();
    expect(s.rect).toEqual({ x: 10, y: 10, width: 13, height: 13 });
  });

  it('given_a_button_under_a_modal_overlay_then_it_is_still_reported_obscured', () => {
    // The proxy must not become a way to click through genuine overlays: a button
    // has no label, so nothing rescues it — which is correct.
    document.body.innerHTML = `
      <button data-pf-ref="pf1">Save</button>
      <div class="overlay">blocking</div>`;
    const btn = document.querySelector('button') as HTMLElement;
    const overlay = document.querySelector('.overlay') as HTMLElement;
    rects.set(btn, rect(50, 50, 80, 30));
    rects.set(overlay, rect(0, 0, 500, 500));

    const s = sample('pf1');
    expect(s.receivesEvents).toBe(false);
    expect(s.obscuredBy).toContain('div');
    expect(s.proxiedBy).toBeUndefined();
  });

  it('given_a_hidden_input_whose_label_is_ALSO_hidden_then_it_stays_unactionable', () => {
    // No usable interaction surface exists, and inventing one would report a
    // control as testable when a user cannot reach it either.
    document.body.innerHTML = `
      <label style="display:none"><input data-pf-ref="pf1" type="checkbox" style="opacity:0"></label>`;
    const input = document.querySelector('input') as HTMLInputElement;
    const label = document.querySelector('label') as HTMLLabelElement;
    rects.set(input, rect(10, 10, 13, 13));
    rects.set(label, rect(0, 0, 0, 0));

    const s = sample('pf1');
    expect(s.visible).toBe(false);
    expect(s.proxiedBy).toBeUndefined();
  });

  it('given_a_label_referenced_by_FOR_rather_than_wrapping_then_it_still_proxies', () => {
    document.body.innerHTML = `
      <label for="agree">I agree</label>
      <input data-pf-ref="pf1" id="agree" type="checkbox" style="opacity:0">`;
    const input = document.querySelector('input') as HTMLInputElement;
    const label = document.querySelector('label') as HTMLLabelElement;
    rects.set(input, rect(200, 200, 13, 13));
    rects.set(label, rect(20, 200, 90, 20));

    const s = sample('pf1');
    expect(s.receivesEvents).toBe(true);
    expect(s.rect).toEqual({ x: 20, y: 200, width: 90, height: 20 });
  });
});
