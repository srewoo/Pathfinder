/**
 * Assertion semantics after the §3 port from `content/dom-actions.ts`.
 *
 * The scripts run in a real DOM (jsdom) via a driver whose `evaluate` executes
 * the generated expression. That is the only way to verify the ported behaviours
 * actually survived — several are load-bearing and silently easy to lose:
 * case-insensitive substring matching, the toast fallback, and shadow-DOM
 * piercing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/core/cdp/cdp-client', () => ({
  isAttached: vi.fn().mockReturnValue(true),
}));

const { assertExpr, TOAST_SELECTORS } = await import('../../../src/drivers/assert-scripts');
const { executeStepViaDriver, setDriverForTab, releaseDriver } = await import(
  '../../../src/drivers/step-runner'
);
const { createFakeDriver } = await import('../../../src/drivers/fake-driver');

const TAB = 7;

/**
 * Evaluate an assertion expression against the current jsdom document.
 *
 * `eval` here is a test harness executing our own generated script, standing in
 * for CDP's `Runtime.evaluate`. It is the only faithful way to test the page-side
 * code without a real browser.
 */
function evalAssert(step: Record<string, unknown>): { success: boolean; error?: string } {
  // eslint-disable-next-line no-eval
  return eval(assertExpr(step as never)) as { success: boolean; error?: string };
}

/** A driver whose `evaluate` runs the expression against jsdom. */
function domDriver() {
  const d = createFakeDriver({ elements: [] }, { timeoutMs: 120, pollMs: 10 });
  d.evaluate = (async (expression: string) => {
    // eslint-disable-next-line no-eval
    return eval(expression);
  }) as typeof d.evaluate;
  setDriverForTab(TAB, d);
  return d;
}

beforeEach(() => {
  releaseDriver(TAB);
  document.body.innerHTML = '';
});

describe('presence assertions', () => {
  it('given_an_existing_element_then_exists_passes', () => {
    document.body.innerHTML = `<div id="a">hi</div>`;
    expect(evalAssert({ selector: '#a', assertType: 'exists' }).success).toBe(true);
  });

  it('given_a_missing_element_then_exists_fails_and_flags_notFound', () => {
    const r = evalAssert({ selector: '#gone', assertType: 'exists' }) as {
      success: boolean;
      notFound?: boolean;
      error?: string;
    };
    expect(r.success).toBe(false);
    expect(r.notFound).toBe(true);
  });

  it('given_a_missing_element_then_not_exists_passes', () => {
    expect(evalAssert({ selector: '#gone', assertType: 'not_exists' }).success).toBe(true);
  });

  it('given_a_present_element_then_not_exists_fails_and_describes_it', () => {
    document.body.innerHTML = `<span id="a">still here</span>`;
    const r = evalAssert({ selector: '#a', assertType: 'not_exists' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('<span>');
    expect(r.error).toContain('still here');
  });
});

describe('text assertions', () => {
  it('given_matching_text_then_it_passes', () => {
    document.body.innerHTML = `<p id="m">Order created successfully</p>`;
    expect(
      evalAssert({ selector: '#m', assertType: 'text', assertExpected: 'created' }).success
    ).toBe(true);
  });

  it('given_different_casing_then_it_still_passes', () => {
    // Case-insensitive substring matching is the original behaviour; tightening
    // it would fail large numbers of existing tests.
    document.body.innerHTML = `<p id="m">ORDER CREATED</p>`;
    expect(
      evalAssert({ selector: '#m', assertType: 'text', assertExpected: 'order created' }).success
    ).toBe(true);
  });

  it('given_a_mismatch_then_the_error_shows_the_actual_text_and_the_url', () => {
    document.body.innerHTML = `<p id="m">Something else</p>`;
    const r = evalAssert({ selector: '#m', assertType: 'text', assertExpected: 'created' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('Something else');
    expect(r.error).toContain('[');
  });

  it('given_the_text_only_in_a_toast_then_it_still_passes', () => {
    // Success messages are frequently transient and live outside the asserted
    // element — losing this fallback would fail many correct tests.
    document.body.innerHTML = `
      <p id="m">nothing here</p>
      <div role="status">Saved successfully</div>`;
    expect(
      evalAssert({ selector: '#m', assertType: 'text', assertExpected: 'Saved successfully' })
        .success
    ).toBe(true);
  });

  it('given_a_missing_element_but_the_text_in_a_toast_then_it_passes', () => {
    document.body.innerHTML = `<div class="Toastify__toast">Deleted</div>`;
    expect(
      evalAssert({ selector: '#absent', assertType: 'text', assertExpected: 'Deleted' }).success
    ).toBe(true);
  });

  it('given_not_text_and_absent_text_then_it_passes', () => {
    document.body.innerHTML = `<p id="m">all good</p>`;
    expect(
      evalAssert({ selector: '#m', assertType: 'not_text', assertExpected: 'error' }).success
    ).toBe(true);
  });

  it('given_not_text_and_present_text_then_it_fails', () => {
    document.body.innerHTML = `<p id="m">an error occurred</p>`;
    expect(
      evalAssert({ selector: '#m', assertType: 'not_text', assertExpected: 'error' }).success
    ).toBe(false);
  });

  it('given_every_declared_toast_selector_then_it_is_scanned', () => {
    // Guards against a selector being dropped in a future edit.
    for (const sel of TOAST_SELECTORS) {
      const tag = sel.startsWith('[') ? 'div' : 'div';
      const attr = sel.startsWith('[role=')
        ? `role="${sel.slice(7, -2)}"`
        : sel.startsWith('[class')
          ? 'class="my-toast-thing"'
          : `class="${sel.slice(1)}"`;
      document.body.innerHTML = `<${tag} ${attr}>Unique-Toast-Text</${tag}>`;
      const r = evalAssert({
        selector: '#absent',
        assertType: 'text',
        assertExpected: 'Unique-Toast-Text',
      });
      expect(r.success, `selector ${sel} was not scanned`).toBe(true);
    }
  });
});

describe('value and attribute assertions', () => {
  it('given_a_matching_input_value_then_it_passes', () => {
    document.body.innerHTML = `<input id="i" value="hello" />`;
    expect(
      evalAssert({ selector: '#i', assertType: 'value', assertExpected: 'hello' }).success
    ).toBe(true);
  });

  it('given_a_case_differing_value_then_it_still_passes', () => {
    document.body.innerHTML = `<input id="i" value="HELLO" />`;
    expect(
      evalAssert({ selector: '#i', assertType: 'value', assertExpected: 'hello' }).success
    ).toBe(true);
  });

  it('given_a_matching_attribute_then_it_passes', () => {
    document.body.innerHTML = `<div id="d" data-state="active"></div>`;
    expect(
      evalAssert({
        selector: '#d',
        assertType: 'attribute',
        attribute: 'data-state',
        assertExpected: 'active',
      }).success
    ).toBe(true);
  });

  it('given_no_attribute_name_then_it_fails_with_an_explicit_message', () => {
    document.body.innerHTML = `<div id="d"></div>`;
    const r = evalAssert({ selector: '#d', assertType: 'attribute', assertExpected: 'x' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/No attribute name/);
  });
});

describe('enabled / disabled', () => {
  it('given_an_enabled_button_then_enabled_passes_and_disabled_fails', () => {
    document.body.innerHTML = `<button id="b">Go</button>`;
    expect(evalAssert({ selector: '#b', assertType: 'enabled' }).success).toBe(true);
    expect(evalAssert({ selector: '#b', assertType: 'disabled' }).success).toBe(false);
  });

  it('given_a_disabled_button_then_disabled_passes', () => {
    document.body.innerHTML = `<button id="b" disabled>Go</button>`;
    expect(evalAssert({ selector: '#b', assertType: 'disabled' }).success).toBe(true);
  });
});

describe('count assertions', () => {
  it('given_count_then_it_is_a_minimum', () => {
    document.body.innerHTML = `<ul><li class="r"></li><li class="r"></li><li class="r"></li></ul>`;
    expect(
      evalAssert({ selector: '.r', assertType: 'count', assertExpected: '2' }).success
    ).toBe(true);
  });

  it('given_exact_count_then_a_higher_count_fails', () => {
    document.body.innerHTML = `<ul><li class="r"></li><li class="r"></li><li class="r"></li></ul>`;
    const r = evalAssert({ selector: '.r', assertType: 'exact_count', assertExpected: '2' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('got 3');
  });
});

describe('url assertion', () => {
  it('given_a_url_substring_match_then_it_passes_without_a_selector', () => {
    expect(evalAssert({ assertType: 'url', assertExpected: 'localhost' }).success).toBe(true);
  });

  it('given_a_url_mismatch_then_it_fails', () => {
    const r = evalAssert({ assertType: 'url', assertExpected: '/no-such-path' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/URL mismatch/);
  });
});

describe('shadow DOM', () => {
  it('given_an_element_inside_an_open_shadow_root_then_it_is_found', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    host.attachShadow({ mode: 'open' }).innerHTML = `<button id="inner">Deep</button>`;
    expect(evalAssert({ selector: '#inner', assertType: 'exists' }).success).toBe(true);
  });
});

describe('missing selector handling', () => {
  it('given_no_selector_for_an_element_assertion_then_it_fails_explicitly', () => {
    const r = evalAssert({ assertType: 'visible' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/No selector provided/);
  });

  it('given_an_unknown_assertType_then_it_fails_rather_than_passing', () => {
    document.body.innerHTML = `<div id="d"></div>`;
    const r = evalAssert({ selector: '#d', assertType: 'made_up' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Unknown assertType/);
  });
});

describe('polling through the step runner', () => {
  it('given_text_that_appears_late_then_the_assertion_still_passes', async () => {
    // Polling (not a one-shot check) is why async updates are not flake.
    document.body.innerHTML = `<p id="m"></p>`;
    domDriver();
    setTimeout(() => {
      const el = document.getElementById('m');
      if (el) el.textContent = 'Saved successfully';
    }, 30);

    const r = await executeStepViaDriver(
      {
        order: 0,
        action: 'assert',
        selector: '#m',
        assertType: 'text',
        assertExpected: 'Saved',
        description: 'shows success',
        timeout: 1000,
      },
      TAB
    );
    expect(r.success).toBe(true);
  });

  it('given_text_that_never_appears_then_it_fails_with_the_last_observed_error', async () => {
    document.body.innerHTML = `<p id="m">nope</p>`;
    domDriver();
    const r = await executeStepViaDriver(
      {
        order: 0,
        action: 'assert',
        selector: '#m',
        assertType: 'text',
        assertExpected: 'Saved',
        description: 'shows success',
        timeout: 60,
      },
      TAB
    );
    expect(r.success).toBe(false);
    expect(r.error).toContain('nope');
  });
});
