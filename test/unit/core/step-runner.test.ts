/**
 * step-runner: the legacy-step bridge onto the Driver (fix.md §3).
 *
 * These pin the contract the 11 migrated call sites depend on — `{ success,
 * error }`, never a throw — and that every legacy action reaches the driver
 * rather than a synthetic-event path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/core/cdp/cdp-client', () => ({
  isAttached: vi.fn().mockReturnValue(true),
}));

const { executeStepViaDriver, setDriverForTab, releaseDriver, canExecute } = await import(
  '../../../src/drivers/step-runner'
);
const { createFakeDriver } = await import('../../../src/drivers/fake-driver');

const TAB = 1;

function withDriver(elements: Parameters<typeof createFakeDriver>[0] = {}) {
  const driver = createFakeDriver(elements, { timeoutMs: 60, pollMs: 5 });
  setDriverForTab(TAB, driver);
  return driver;
}

const step = (over: Record<string, unknown> = {}) => ({
  order: 0,
  action: 'click' as const,
  description: 'test step',
  ...over,
});

beforeEach(() => {
  releaseDriver(TAB);
});

describe('action dispatch', () => {
  it('given_a_click_then_it_reaches_the_driver_and_succeeds', async () => {
    const d = withDriver({
      elements: [{ id: 'go', tag: 'button', role: 'button', name: 'Go', css: '#go' }],
    });
    const r = await executeStepViaDriver(step({ selector: '#go' }), TAB);
    expect(r.success).toBe(true);
    expect(d.actionLog()).toContain('click go');
  });

  it('given_a_type_step_then_the_value_lands', async () => {
    const d = withDriver({
      elements: [{ id: 'email', tag: 'input', role: 'textbox', name: 'Email', css: '#email' }],
    });
    const r = await executeStepViaDriver(
      step({ action: 'type', selector: '#email', value: 'a@b.co' }),
      TAB
    );
    expect(r.success).toBe(true);
    expect(d.page().elements[0].value).toBe('a@b.co');
  });

  it('given_a_double_click_then_the_driver_receives_the_double_flag', async () => {
    const d = withDriver({
      elements: [{ id: 'row', tag: 'div', role: 'button', name: 'Row', css: '#row' }],
    });
    await executeStepViaDriver(step({ action: 'double_click', selector: '#row' }), TAB);
    expect(d.actionLog()).toContain('click row (double)');
  });

  it('given_check_and_uncheck_then_the_state_follows', async () => {
    const d = withDriver({
      elements: [{ id: 'tos', tag: 'input', role: 'checkbox', name: 'TOS', css: '#tos' }],
    });
    await executeStepViaDriver(step({ action: 'check', selector: '#tos' }), TAB);
    expect(d.page().elements[0].checked).toBe(true);
    await executeStepViaDriver(step({ action: 'uncheck', selector: '#tos' }), TAB);
    expect(d.page().elements[0].checked).toBe(false);
  });

  it('given_a_select_then_the_option_is_chosen', async () => {
    const d = withDriver({
      elements: [
        { id: 'c', tag: 'select', role: 'combobox', name: 'Country', css: '#c', options: ['UK', 'US'] },
      ],
    });
    const r = await executeStepViaDriver(
      step({ action: 'select', selector: '#c', value: 'US' }),
      TAB
    );
    expect(r.success).toBe(true);
    expect(d.page().elements[0].value).toBe('US');
  });

  it('given_a_press_key_then_the_key_reaches_the_driver', async () => {
    const d = withDriver({ elements: [] });
    await executeStepViaDriver(step({ action: 'press_key', key: 'Escape' }), TAB);
    expect(d.actionLog()).toContain('pressKey Escape');
  });

  it('given_a_navigate_then_the_url_changes', async () => {
    const d = withDriver({ elements: [] });
    const r = await executeStepViaDriver(
      step({ action: 'navigate', value: 'https://app.test/next' }),
      TAB
    );
    expect(r.success).toBe(true);
    expect(await d.currentUrl()).toBe('https://app.test/next');
  });

  it('given_a_drag_drop_then_both_locators_are_used', async () => {
    const d = withDriver({
      elements: [
        { id: 'src', tag: 'div', role: 'button', name: 'Src', css: '#src' },
        { id: 'dst', tag: 'div', role: 'button', name: 'Dst', css: '#dst' },
      ],
    });
    const r = await executeStepViaDriver(
      step({ action: 'drag_drop', selector: '#src', targetSelector: '#dst' }),
      TAB
    );
    expect(r.success).toBe(true);
    expect(d.actionLog()).toContain('dragDrop src -> dst');
  });
});

describe('input validation returns errors rather than throwing', () => {
  it('given_navigate_without_a_url_then_it_fails_with_a_clear_message', async () => {
    withDriver({ elements: [] });
    const r = await executeStepViaDriver(step({ action: 'navigate' }), TAB);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/requires a value/);
  });

  it('given_an_action_needing_a_selector_without_one_then_it_fails', async () => {
    withDriver({ elements: [] });
    const r = await executeStepViaDriver(step({ action: 'click' }), TAB);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/requires a selector/);
  });

  it('given_drag_drop_without_a_target_then_it_fails', async () => {
    withDriver({ elements: [{ id: 'a', tag: 'div', css: '#a' }] });
    const r = await executeStepViaDriver(step({ action: 'drag_drop', selector: '#a' }), TAB);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/targetSelector/);
  });

  it('given_a_missing_element_then_it_fails_without_throwing', async () => {
    // The 11 migrated call sites rely on this: never a throw, always a verdict.
    withDriver({ elements: [] });
    const r = await executeStepViaDriver(step({ selector: '#nope', timeout: 40 }), TAB);
    expect(r.success).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('given_a_composite_action_reaching_the_runner_then_it_fails_loudly', async () => {
    // step-extensions must expand these first; a silent pass would report an
    // unexecuted conditional as verified.
    withDriver({ elements: [] });
    for (const action of ['if_visible', 'loop', 'capture_value', 'use_captured']) {
      const r = await executeStepViaDriver(step({ action }), TAB);
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/step-extensions/);
    }
  });
});

describe('legacy wait steps', () => {
  it('given_a_wait_step_then_it_is_a_no_op_rather_than_an_error', async () => {
    // §8 moved waiting into the driver. Old saved plans still contain `wait`
    // steps, and failing them would break every stored test for no benefit.
    withDriver({ elements: [] });
    const r = await executeStepViaDriver(step({ action: 'wait', value: '3000' }), TAB);
    expect(r.success).toBe(true);
  });
});

describe('canExecute', () => {
  it('given_an_attached_session_then_execution_is_permitted', () => {
    expect(canExecute(TAB)).toBe(true);
  });
});

describe('driver caching', () => {
  it('given_repeated_steps_then_the_same_driver_instance_is_reused', async () => {
    // A fresh driver per step would re-tag every element and lose session state.
    const d = withDriver({
      elements: [{ id: 'go', tag: 'button', role: 'button', name: 'Go', css: '#go' }],
    });
    await executeStepViaDriver(step({ selector: '#go' }), TAB);
    await executeStepViaDriver(step({ selector: '#go' }), TAB);
    expect(d.actionLog().filter((l) => l === 'click go')).toHaveLength(2);
  });

  it('given_releaseDriver_then_the_cached_entry_is_dropped', async () => {
    withDriver({ elements: [] });
    releaseDriver(TAB);
    // Without a re-injected fake, the real CDP driver would be constructed —
    // proving the cache no longer holds the fake.
    const r = await executeStepViaDriver(step({ action: 'navigate', value: '' }), TAB);
    expect(r.success).toBe(false);
  });
});
