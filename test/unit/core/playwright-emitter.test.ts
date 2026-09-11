import { describe, it, expect } from 'vitest';
import {
  emitPlaywrightTest,
  emitPlaywrightSuite,
} from '../../../src/core/export/playwright-emitter';
import { IR_VERSION, type TestIR } from '../../../src/core/ir/test-ir';

function ir(overrides: Partial<TestIR> = {}): TestIR {
  return {
    irVersion: IR_VERSION,
    id: 't1',
    name: 'User can sign in',
    startUrl: 'https://app.example.com/login',
    provenance: {
      source: 'user',
      promptVersion: 'n/a',
      model: 'n/a',
      generatedAt: 0,
      deterministic: true,
    },
    steps: [],
    assertions: [
      {
        order: 0,
        kind: 'visible',
        locator: { preferredTier: 'testid', testid: 'home' },
        description: 'Home visible',
        confidence: 'grounded',
      },
    ],
    tags: [],
    ...overrides,
  } as TestIR;
}

describe('emitPlaywrightTest', () => {
  it('given_ir_then_emits_import_and_test_block', () => {
    const { source } = emitPlaywrightTest(ir());
    expect(source).toContain("import { test, expect } from '@playwright/test';");
    expect(source).toContain("test('User can sign in'");
    expect(source).toContain('async ({ page }) => {');
    expect(source.trimEnd().endsWith('});')).toBe(true);
  });

  it('given_tags_then_emits_playwright_tag_option', () => {
    const { source } = emitPlaywrightTest(ir({ tags: ['smoke', 'auth'] }));
    expect(source).toContain("{ tag: ['@smoke', '@auth'] }");
  });

  it('given_start_url_then_navigates_first', () => {
    const { source } = emitPlaywrightTest(ir());
    expect(source).toContain("await page.goto('https://app.example.com/login');");
    expect(source).toContain("await page.waitForLoadState('load');");
  });

  it('given_click_and_type_steps_then_emits_actions_with_intent_comments', () => {
    const { source } = emitPlaywrightTest(
      ir({
        steps: [
          {
            order: 0,
            action: 'type',
            locator: { preferredTier: 'testid', testid: 'email' },
            value: 'a@b.com',
            description: 'Enter the email',
          },
          {
            order: 1,
            action: 'click',
            locator: { preferredTier: 'semantic', semantic: { role: 'button', name: 'Sign in' } },
            description: 'Submit the form',
          },
        ],
      })
    );
    expect(source).toContain('// Enter the email');
    expect(source).toContain("await page.getByTestId('email').fill('a@b.com');");
    expect(source).toContain('// Submit the form');
    expect(source).toContain("await page.getByRole('button', { name: 'Sign in' }).click();");
  });

  it('given_capture_then_declares_a_const_and_later_step_uses_a_template_literal', () => {
    const { source } = emitPlaywrightTest(
      ir({
        steps: [
          {
            order: 0,
            action: 'capture',
            locator: { preferredTier: 'testid', testid: 'order-no' },
            captureAs: 'orderNo',
            captureFrom: 'text',
            description: 'Read the order number',
          },
          {
            order: 1,
            action: 'type',
            locator: { preferredTier: 'testid', testid: 'search' },
            value: 'order {{orderNo}}',
            description: 'Search for it',
          },
        ],
      })
    );
    expect(source).toContain("const orderNo = await page.getByTestId('order-no').innerText();");
    expect(source).toContain("await page.getByTestId('search').fill(`order ${orderNo}`);");
  });

  it('given_capture_from_attribute_then_reads_that_attribute', () => {
    const { source } = emitPlaywrightTest(
      ir({
        steps: [
          {
            order: 0,
            action: 'capture',
            locator: { preferredTier: 'testid', testid: 'link' },
            captureAs: 'href',
            captureFrom: 'attribute',
            attribute: 'href',
            description: 'Read the href',
          },
        ],
      })
    );
    expect(source).toContain("const href = await page.getByTestId('link').getAttribute('href');");
  });

  it('given_drag_drop_then_uses_the_stepped_helper', () => {
    const { source } = emitPlaywrightTest(
      ir({
        steps: [
          {
            order: 0,
            action: 'drag_drop',
            locator: { preferredTier: 'testid', testid: 'card' },
            targetLocator: { preferredTier: 'testid', testid: 'lane' },
            description: 'Drag the card into the lane',
          },
        ],
      })
    );
    expect(source).toContain('async function smoothDragTo(');
    expect(source).toContain(
      "await smoothDragTo(page, page.getByTestId('card'), page.getByTestId('lane'));"
    );
  });

  it('given_no_drag_step_then_helper_is_not_emitted', () => {
    const { source } = emitPlaywrightTest(ir());
    expect(source).not.toContain('smoothDragTo');
  });

  it('given_assertions_then_emits_expect_calls', () => {
    const { source } = emitPlaywrightTest(
      ir({
        assertions: [
          {
            order: 0,
            kind: 'visible',
            locator: { preferredTier: 'testid', testid: 'banner' },
            description: 'Banner shows',
            confidence: 'grounded',
          },
          {
            order: 1,
            kind: 'text',
            locator: { preferredTier: 'testid', testid: 'banner' },
            expected: 'Saved',
            description: 'Banner says saved',
            confidence: 'grounded',
          },
          {
            order: 2,
            kind: 'url',
            expected: 'https://app.example.com/home',
            description: 'Landed on home',
            confidence: 'grounded',
          },
          {
            order: 3,
            kind: 'exact_count',
            locator: { preferredTier: 'testid', testid: 'row' },
            expected: '3',
            description: 'Three rows',
            confidence: 'grounded',
          },
        ],
      })
    );
    expect(source).toContain("await expect(page.getByTestId('banner')).toBeVisible();");
    expect(source).toContain("await expect(page.getByTestId('banner')).toContainText('Saved');");
    expect(source).toContain("await expect(page).toHaveURL('https://app.example.com/home');");
    expect(source).toContain("await expect(page.getByTestId('row')).toHaveCount(3);");
  });

  it('given_negated_assertions_then_emits_the_not_form', () => {
    const { source } = emitPlaywrightTest(
      ir({
        assertions: [
          {
            order: 0,
            kind: 'not_visible',
            locator: { preferredTier: 'testid', testid: 'spinner' },
            description: 'Spinner gone',
            confidence: 'grounded',
          },
          {
            order: 1,
            kind: 'not_exists',
            locator: { preferredTier: 'testid', testid: 'error' },
            description: 'No error',
            confidence: 'grounded',
          },
        ],
      })
    );
    expect(source).toContain("await expect(page.getByTestId('spinner')).not.toBeVisible();");
    expect(source).toContain("await expect(page.getByTestId('error')).not.toBeAttached();");
  });

  it('given_after_step_assertion_then_it_is_interleaved_not_appended', () => {
    const { source } = emitPlaywrightTest(
      ir({
        steps: [
          {
            order: 0,
            action: 'click',
            locator: { preferredTier: 'testid', testid: 'save' },
            description: 'Click save',
          },
          {
            order: 1,
            action: 'click',
            locator: { preferredTier: 'testid', testid: 'away' },
            description: 'Navigate away',
          },
        ],
        assertions: [
          {
            order: 0,
            kind: 'visible',
            locator: { preferredTier: 'testid', testid: 'toast' },
            description: 'Toast appears',
            confidence: 'grounded',
            afterStep: 0,
          },
        ],
      })
    );
    const toastAt = source.indexOf('toast');
    const awayAt = source.indexOf('away');
    expect(toastAt).toBeGreaterThan(-1);
    expect(toastAt).toBeLessThan(awayAt);
  });

  // Network assertions have no static equivalent in a plain spec file. They are
  // reported, never emitted as a comment that would silently weaken the test.
  it('given_api_assertion_then_it_is_dropped_with_a_reason', () => {
    const { source, dropped } = emitPlaywrightTest(
      ir({
        assertions: [
          {
            order: 0,
            kind: 'visible',
            locator: { preferredTier: 'testid', testid: 'ok' },
            description: 'ok',
            confidence: 'grounded',
          },
          {
            order: 1,
            kind: 'api_status',
            expected: '200',
            description: 'API returned 200',
            confidence: 'grounded',
          },
        ],
      })
    );
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatch(/api_status/);
    expect(source).not.toContain('api_status');
  });

  it('given_unemittable_locator_then_step_is_dropped_with_its_description', () => {
    const { source, dropped } = emitPlaywrightTest(
      ir({
        steps: [
          {
            order: 0,
            action: 'click',
            locator: { preferredTier: 'semantic', semantic: { role: 'generic', name: 'x' } },
            description: 'Click the mystery thing',
          },
        ],
      })
    );
    expect(dropped.join(' ')).toContain('Click the mystery thing');
    expect(source).not.toContain('mystery');
  });

  it('given_apostrophe_in_name_then_test_title_is_escaped', () => {
    const { source } = emitPlaywrightTest(ir({ name: "User's profile loads" }));
    expect(source).toContain("test('User\\'s profile loads'");
  });

  it('given_press_key_then_uses_the_keyboard', () => {
    const { source } = emitPlaywrightTest(
      ir({ steps: [{ order: 0, action: 'press_key', key: 'Enter', description: 'Press enter' }] })
    );
    expect(source).toContain("await page.keyboard.press('Enter');");
  });

  it('given_scroll_without_a_locator_then_uses_the_wheel', () => {
    const { source } = emitPlaywrightTest(
      ir({ steps: [{ order: 0, action: 'scroll', description: 'Scroll down' }] })
    );
    expect(source).toContain('await page.mouse.wheel(0, 600);');
  });

  it('given_emitted_source_then_it_is_balanced_and_has_no_placeholder_markers', () => {
    const { source } = emitPlaywrightTest(
      ir({
        steps: [
          {
            order: 0,
            action: 'click',
            locator: { preferredTier: 'testid', testid: 'x' },
            description: 'Click x',
          },
        ],
      })
    );
    expect(source).not.toMatch(/TODO|FIXME|undefined/);
    expect((source.match(/\{/g) ?? []).length).toBe((source.match(/\}/g) ?? []).length);
  });
});

describe('emitPlaywrightSuite', () => {
  it('given_two_irs_then_one_file_with_one_import_and_two_tests', () => {
    const { source } = emitPlaywrightSuite([ir({ id: 'a', name: 'A' }), ir({ id: 'b', name: 'B' })]);
    expect(source.match(/import \{ test, expect \}/g)).toHaveLength(1);
    expect(source).toContain("test('A'");
    expect(source).toContain("test('B'");
  });

  it('given_two_irs_then_dropped_items_are_merged', () => {
    const { dropped } = emitPlaywrightSuite([
      ir({
        id: 'a',
        name: 'A',
        assertions: [
          {
            order: 0,
            kind: 'visible',
            locator: { preferredTier: 'testid', testid: 'ok' },
            description: 'ok',
            confidence: 'grounded',
          },
          { order: 1, kind: 'api_called', description: 'called', confidence: 'grounded' },
        ],
      }),
      ir({
        id: 'b',
        name: 'B',
        assertions: [
          {
            order: 0,
            kind: 'visible',
            locator: { preferredTier: 'testid', testid: 'ok' },
            description: 'ok',
            confidence: 'grounded',
          },
          { order: 1, kind: 'api_not_called', description: 'not called', confidence: 'grounded' },
        ],
      }),
    ]);
    expect(dropped).toHaveLength(2);
  });

  it('given_one_ir_with_a_drag_step_then_the_helper_is_emitted_once', () => {
    const { source } = emitPlaywrightSuite([
      ir({
        id: 'a',
        name: 'A',
        steps: [
          {
            order: 0,
            action: 'drag_drop',
            locator: { preferredTier: 'testid', testid: 'c' },
            targetLocator: { preferredTier: 'testid', testid: 'l' },
            description: 'Drag',
          },
        ],
      }),
      ir({ id: 'b', name: 'B' }),
    ]);
    expect(source.match(/async function smoothDragTo/g)).toHaveLength(1);
  });
});
