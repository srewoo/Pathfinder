import { describe, it, expect } from 'vitest';
import { createFakeDriver } from '../../../src/drivers/fake-driver';
import { fromCss, fromRole, fromTestId } from '../../../src/core/locator';
import { NotActionableError } from '../../../src/core/actionability';

function driverWithButton(extra: Record<string, unknown> = {}) {
  return createFakeDriver({
    elements: [
      {
        id: 'save',
        tag: 'button',
        role: 'button',
        name: 'Save',
        testid: 'save-btn',
        css: '#save',
        ...extra,
      },
    ],
  });
}

describe('fake-driver resolution ladder', () => {
  it('given_a_testid_locator_then_resolves_at_the_testid_tier_unhealed', async () => {
    const d = driverWithButton();
    const h = await d.resolve(fromTestId('save-btn'));
    expect(h?.tier).toBe('testid');
    expect(h?.healed).toBe(false);
  });

  it('given_a_semantic_locator_then_resolves_by_role_and_name', async () => {
    const d = driverWithButton();
    const h = await d.resolve(fromRole('button', 'Save'));
    expect(h?.tier).toBe('semantic');
  });

  it('given_a_missing_testid_but_present_semantic_then_it_degrades_and_reports_healed', async () => {
    // This is the signal §5 requires: resolution below preferredTier is a heal
    // and must never be silent.
    const d = driverWithButton();
    const loc = {
      testid: 'gone',
      semantic: { role: 'button' as const, name: 'Save' },
      preferredTier: 'testid' as const,
    };
    const h = await d.resolve(loc);
    expect(h?.tier).toBe('semantic');
    expect(h?.healed).toBe(true);
  });

  it('given_no_matching_tier_then_resolve_returns_null', async () => {
    const d = driverWithButton();
    expect(await d.resolve(fromTestId('nope'))).toBeNull();
  });

  it('given_a_detached_element_then_it_does_not_resolve', async () => {
    const d = driverWithButton({ attached: false });
    expect(await d.resolve(fromTestId('save-btn'))).toBeNull();
  });
});

describe('fake-driver actionability integration', () => {
  it('given_a_settled_button_when_clicked_then_it_passes_and_logs', async () => {
    const d = driverWithButton();
    await d.click(fromTestId('save-btn'));
    expect(d.actionLog()).toContain('click save');
  });

  it('given_a_disabled_button_when_clicked_then_it_throws_NotActionable', async () => {
    const d = driverWithButton({ enabled: false });
    await expect(d.click(fromTestId('save-btn'), { timeoutMs: 40 })).rejects.toThrow(
      NotActionableError
    );
  });

  it('given_an_obscured_button_when_clicked_then_the_error_names_the_obscurer', async () => {
    const d = driverWithButton({ obscuredBy: 'div.MuiBackdrop-root' });
    await expect(d.click(fromTestId('save-btn'), { timeoutMs: 40 })).rejects.toThrow(
      /MuiBackdrop-root/
    );
  });

  it('given_an_element_that_settles_late_then_the_click_waits_rather_than_failing', async () => {
    // Animating for 3 samples: proves the wait is real, not a fixed sleep.
    const d = driverWithButton({ movingForSamples: 3 });
    await d.click(fromTestId('save-btn'), { timeoutMs: 1000 });
    expect(d.actionLog()).toContain('click save');
  });

  it('given_an_element_that_appears_late_then_the_click_still_succeeds', async () => {
    const d = createFakeDriver({ elements: [] });
    setTimeout(() => {
      d.setPage({
        elements: [{ id: 'late', tag: 'button', role: 'button', name: 'Go', testid: 'go' }],
      });
    }, 20);
    await d.click(fromTestId('go'), { timeoutMs: 1000 });
    expect(d.actionLog()).toContain('click late');
  });

  it('given_an_obscurer_that_clears_then_the_click_proceeds', async () => {
    const d = driverWithButton({ obscuredBy: 'div.overlay' });
    setTimeout(() => d.patch('save', { obscuredBy: undefined }), 20);
    await d.click(fromTestId('save-btn'), { timeoutMs: 1000 });
    expect(d.actionLog()).toContain('click save');
  });
});

describe('fake-driver actions mutate page state', () => {
  it('given_a_type_action_then_the_value_lands', async () => {
    const d = createFakeDriver({
      elements: [{ id: 'email', tag: 'input', role: 'textbox', name: 'Email', testid: 'email' }],
    });
    await d.type(fromTestId('email'), 'a@b.co');
    expect(d.page().elements[0].value).toBe('a@b.co');
  });

  it('given_type_with_clear_false_then_it_appends', async () => {
    const d = createFakeDriver({
      elements: [
        { id: 'q', tag: 'input', role: 'textbox', name: 'Q', testid: 'q', value: 'ab' },
      ],
    });
    await d.type(fromTestId('q'), 'cd', { clear: false });
    expect(d.page().elements[0].value).toBe('abcd');
  });

  it('given_setChecked_then_the_checkbox_state_changes', async () => {
    const d = createFakeDriver({
      elements: [{ id: 'tos', tag: 'input', role: 'checkbox', name: 'Accept', testid: 'tos' }],
    });
    await d.setChecked(fromTestId('tos'), true);
    expect(d.page().elements[0].checked).toBe(true);
  });

  it('given_selectOption_with_an_absent_option_then_it_throws', async () => {
    const d = createFakeDriver({
      elements: [
        { id: 'c', tag: 'select', role: 'combobox', name: 'Country', testid: 'c', options: ['UK'] },
      ],
    });
    await expect(d.selectOption(fromTestId('c'), 'Mars')).rejects.toThrow(/not present/);
  });

  it('given_a_click_handler_that_navigates_then_the_url_changes', async () => {
    const d = createFakeDriver({
      url: 'https://app.test/',
      elements: [
        {
          id: 'link',
          tag: 'a',
          role: 'link',
          name: 'Settings',
          testid: 'nav',
          onClick: (p) => {
            p.url = 'https://app.test/settings';
          },
        },
      ],
    });
    await d.click(fromTestId('nav'));
    expect(await d.currentUrl()).toBe('https://app.test/settings');
  });

  it('given_a_click_handler_that_reveals_an_element_then_it_becomes_clickable', async () => {
    const d = createFakeDriver({
      elements: [
        {
          id: 'open',
          tag: 'button',
          role: 'button',
          name: 'Open',
          testid: 'open',
          onClick: (p) => {
            p.elements.push({
              id: 'confirm',
              tag: 'button',
              role: 'button',
              name: 'Confirm',
              testid: 'confirm',
            });
          },
        },
      ],
    });
    await d.click(fromTestId('open'));
    await d.click(fromTestId('confirm'));
    expect(d.actionLog()).toEqual(['click open', 'click confirm']);
  });
});

describe('fake-driver reading', () => {
  it('given_count_then_it_counts_matches_at_the_first_matching_tier', async () => {
    const d = createFakeDriver({
      elements: [
        { id: 'r1', tag: 'tr', role: 'row', name: 'Row' },
        { id: 'r2', tag: 'tr', role: 'row', name: 'Row' },
      ],
    });
    expect(await d.count(fromRole('row', 'Row'))).toBe(2);
  });

  it('given_readAttribute_for_an_absent_attribute_then_null', async () => {
    const d = driverWithButton({ attrs: { 'aria-label': 'Save it' } });
    expect(await d.readAttribute(fromTestId('save-btn'), 'aria-label')).toBe('Save it');
    expect(await d.readAttribute(fromTestId('save-btn'), 'title')).toBeNull();
  });

  it('given_a_structural_locator_then_it_resolves_by_css_string', async () => {
    const d = driverWithButton();
    const h = await d.resolve(fromCss('#save'));
    expect(h?.tier).toBe('structural');
    expect(h?.resolvedCss).toBe('#save');
  });
});

describe('fake-driver network interception', () => {
  it('given_an_interceptor_then_its_verdict_is_returned_and_logged', () => {
    const d = createFakeDriver({ elements: [] });
    d.onRequest((r) =>
      r.method === 'POST' ? { action: 'abort', reason: 'read-only run' } : { action: 'continue' }
    );
    expect(d.emitRequest({ requestId: '1', url: 'https://app.test/a', method: 'GET' })).toEqual({
      action: 'continue',
    });
    expect(d.emitRequest({ requestId: '2', url: 'https://app.test/a', method: 'POST' })).toEqual({
      action: 'abort',
      reason: 'read-only run',
    });
  });

  it('given_no_interceptor_then_requests_continue_by_default', () => {
    const d = createFakeDriver({ elements: [] });
    expect(d.emitRequest({ requestId: '1', url: 'https://x/', method: 'GET' }).action).toBe(
      'continue'
    );
  });

  it('given_responses_then_they_appear_in_the_network_log', () => {
    const d = createFakeDriver({ elements: [] });
    d.emitResponse({ requestId: '1', url: 'https://app.test/api', method: 'GET', status: 200 });
    expect(d.networkLog()).toHaveLength(1);
    expect(d.networkLog()[0].status).toBe(200);
  });
});
