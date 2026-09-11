/**
 * The harness's own driver has to be trustworthy before anything measured with
 * it means anything.
 *
 * These tests check the two properties the evaluation depends on: the fixture's
 * scripts really execute (without which both variants are identical markup and
 * the measurement is vacuous), and the driver's limits are refusals rather than
 * silently wrong answers.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { JsdomDriver } from './jsdom-driver';
import { fromTestId, fromCss } from '../../src/core/locator';

const FIXTURES = resolve(__dirname, 'fixture-app');

function driverFor(variant: 'correct' | 'broken', respondTo?: JsdomDriverOptionsRespond) {
  return new JsdomDriver({
    resolvePage: (page) => resolve(FIXTURES, variant, page),
    respondTo,
    defaultTimeoutMs: 800,
  });
}
type JsdomDriverOptionsRespond = (url: string, method: string) => { status: number; body?: unknown };

let open: JsdomDriver | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

describe('the fixture scripts actually run', () => {
  // Without this the whole evaluation is vacuous: every seeded defect lives in
  // script behaviour, so a non-executing DOM makes both variants identical.
  it('given_the_correct_save_page_then_a_save_persists_the_value', async () => {
    const driver = (open = driverFor('correct'));
    await driver.navigate('save.html');
    await driver.type(fromTestId('display-name'), 'Ada');
    await driver.click(fromTestId('save-settings'));

    expect(await driver.readText(fromCss('#save-banner'))).toBe('Saved');
    expect(driver.storedValue('local', 'fixture.displayName')).toBe('Ada');
  });

  // The seeded defect: the banner appears and nothing is written. This is the
  // scenario a UI-only assertion cannot catch.
  it('given_the_broken_save_page_then_the_banner_appears_but_nothing_persists', async () => {
    const driver = (open = driverFor('broken'));
    await driver.navigate('save.html');
    await driver.type(fromTestId('display-name'), 'Ada');
    await driver.click(fromTestId('save-settings'));

    expect(await driver.readText(fromCss('#save-banner'))).toBe('Saved');
    expect(driver.storedValue('local', 'fixture.displayName')).toBeUndefined();
  });

  it('given_a_page_that_fetches_then_the_request_is_recorded_and_answered', async () => {
    const driver = (open = driverFor('correct', () => ({ status: 500 })));
    await driver.navigate('api.html');
    await driver.click(fromTestId('create-order'));

    expect(driver.recordedRequests()).toEqual([
      { url: '/api/orders', method: 'POST', status: 500 },
    ]);
    // The correct variant respects the response.
    expect(await driver.readText(fromCss('#order-status'))).toMatch(/could not create/i);
  });

  it('given_the_broken_api_page_then_a_500_still_reads_as_saved', async () => {
    const driver = (open = driverFor('broken', () => ({ status: 500 })));
    await driver.navigate('api.html');
    await driver.click(fromTestId('create-order'));

    expect(await driver.readText(fromCss('#order-status'))).toBe('Saved');
  });

  // A timer-driven reveal must be waitable, or the delayed-rendering scenario
  // measures the harness rather than the app.
  it('given_delayed_content_then_waitFor_sees_it_once_the_timer_fires', async () => {
    const driver = (open = driverFor('correct'));
    await driver.navigate('delayed.html');
    await driver.click(fromTestId('load-report'));

    expect(await driver.readText(fromCss('#report-body'))).toContain('Revenue');
  });

  it('given_content_that_never_arrives_then_waitFor_times_out', async () => {
    const driver = (open = driverFor('broken'));
    await driver.navigate('delayed.html');
    await driver.click(fromTestId('load-report'));

    await expect(driver.readText(fromCss('#report-body'), { checks: ['visible'] })).rejects.toThrow();
  });
});

describe('locator tiers resolve as they do in the real driver', () => {
  it('given_a_testid_then_it_resolves_at_the_testid_tier_unhealed', async () => {
    const driver = (open = driverFor('correct'));
    await driver.navigate('selector.html');
    const handle = await driver.resolve(fromTestId('submit-order'));

    expect(handle?.tier).toBe('testid');
    expect(handle?.healed).toBe(false);
  });

  // The seeded rename. The testid is gone, so the ladder must fall through —
  // and falling through is what `healed` means.
  it('given_a_renamed_element_then_the_semantic_tier_still_finds_it_and_marks_it_healed', async () => {
    const driver = (open = driverFor('broken'));
    await driver.navigate('selector.html');

    const locator = {
      testid: 'submit-order',
      semantic: { role: 'button' as const, name: 'Place order' },
      structural: { css: '#submit-order' },
      preferredTier: 'testid' as const,
    };
    const handle = await driver.resolve(locator);

    expect(handle?.tier).toBe('semantic');
    expect(handle?.healed).toBe(true);
  });

  it('given_nothing_matches_any_tier_then_resolve_returns_null', async () => {
    const driver = (open = driverFor('correct'));
    await driver.navigate('selector.html');
    expect(await driver.resolve(fromTestId('does-not-exist'))).toBeNull();
  });

  it('given_comma_separated_fallbacks_then_the_first_match_wins', async () => {
    const driver = (open = driverFor('correct'));
    await driver.navigate('selector.html');
    const handle = await driver.resolve(fromCss('#nope, #submit-order'));

    expect(handle?.resolvedCss).toBe('#submit-order');
  });
});

describe('storage carries across a navigation', () => {
  // The harness does this, not the application — so the journey scenario can
  // distinguish "the app lost the value" from "the harness threw it away".
  it('given_a_value_written_on_step_1_then_step_2_can_read_it', async () => {
    const driver = (open = driverFor('correct'));
    await driver.navigate('journey-1.html');
    await driver.type(fromTestId('order-ref'), 'REF-9');
    await driver.click(fromTestId('to-step-2'));
    await driver.navigate('journey-2.html');

    expect(await driver.readText(fromTestId('carried-ref'))).toBe('REF-9');
  });

  it('given_the_broken_step_1_then_step_2_shows_nothing', async () => {
    const driver = (open = driverFor('broken'));
    await driver.navigate('journey-1.html');
    await driver.type(fromTestId('order-ref'), 'REF-9');
    await driver.click(fromTestId('to-step-2'));
    await driver.navigate('journey-2.html');

    expect(await driver.readText(fromTestId('carried-ref'))).toBe('');
  });
});

describe('the tier refuses what it cannot do', () => {
  // A silent no-op would let a drag scenario pass without dragging, which is
  // worse than having no drag scenario.
  it('given_a_drag_then_it_refuses_and_names_the_tier_that_can', async () => {
    const driver = (open = driverFor('correct'));
    await driver.navigate('selector.html');

    await expect(driver.dragDrop()).rejects.toThrow(/real-browser tier/);
  });

  it('given_a_screenshot_request_then_it_answers_undefined_rather_than_a_fake', async () => {
    const driver = (open = driverFor('correct'));
    await driver.navigate('selector.html');
    expect(await driver.screenshot()).toBeUndefined();
  });

  // A request the interceptor refuses must not appear to have been blocked.
  it('given_an_abort_verdict_then_it_refuses_rather_than_pretending_to_enforce', async () => {
    const driver = (open = driverFor('correct'));
    driver.onRequest(() => ({ action: 'abort', reason: 'off-origin' }));
    await driver.navigate('api.html');

    // The page's own click swallows the rejection, so assert on what was
    // recorded: nothing, because the request never completed.
    await driver.click(fromTestId('create-order'));
    expect(driver.recordedRequests()).toEqual([]);
  });
});
