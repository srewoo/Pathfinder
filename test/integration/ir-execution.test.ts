/**
 * End-to-end through the new stack: TestIR → IR executor → Driver port →
 * fake driver. No browser, no tab, no API key.
 *
 * This is what §2's fake driver was for — the execution path is now testable as
 * a unit, which is why §5's heal reporting and §8's actionability behaviour can
 * be asserted rather than hoped for.
 */
import { describe, it, expect } from 'vitest';
import { createFakeDriver, type FakeElement } from '../../src/drivers/fake-driver';
import { executeIR } from '../../src/core/executor/ir-executor';
import { IR_VERSION, parseTestIR } from '../../src/core/ir/test-ir';
import { fromCss, fromRole, fromTestId } from '../../src/core/locator';
import { createHealLedger } from '../../src/core/report/heal-ledger';
import { generateConstraintTests } from '../../src/core/ir/constraint-ir-generator';
import { buildTestabilityReport } from '../../src/core/report/heal-ledger';

function loginPage(): FakeElement[] {
  return [
    { id: 'email', tag: 'input', role: 'textbox', name: 'Email', testid: 'email', css: '#email' },
    { id: 'pw', tag: 'input', role: 'textbox', name: 'Password', testid: 'password', css: '#pw' },
    {
      id: 'submit',
      tag: 'button',
      role: 'button',
      name: 'Sign in',
      testid: 'submit',
      css: '#submit',
      onClick: (page) => {
        page.url = 'https://app.test/dashboard';
        page.elements.push({
          id: 'welcome',
          tag: 'h1',
          role: 'heading',
          name: 'Welcome back',
          text: 'Welcome back',
          testid: 'welcome',
        });
      },
    },
  ];
}

const loginIR = (overrides: Record<string, unknown> = {}) =>
  parseTestIR({
    irVersion: IR_VERSION,
    id: 'login-happy',
    name: 'User can sign in with valid credentials',
    startUrl: 'https://app.test/login',
    provenance: { source: 'exploration', generatedAt: 1 },
    steps: [
      { order: 0, action: 'navigate', value: 'https://app.test/login', description: 'Open login' },
      { order: 1, action: 'type', locator: fromTestId('email'), value: 'a@b.co', description: 'Enter email' },
      { order: 2, action: 'type', locator: fromTestId('password'), value: 'hunter2', description: 'Enter password' },
      { order: 3, action: 'click', locator: fromTestId('submit'), description: 'Click Sign in' },
    ],
    assertions: [
      { order: 0, kind: 'url', expected: '/dashboard', description: 'Lands on dashboard' },
      { order: 1, kind: 'visible', locator: fromTestId('welcome'), description: 'Welcome shown' },
    ],
    ...overrides,
  });

describe('happy path', () => {
  it('given_a_valid_login_test_then_it_passes_with_no_heals', async () => {
    const driver = createFakeDriver({ url: 'https://app.test/login', elements: loginPage() });
    const result = await executeIR(driver, loginIR());

    expect(result.verdict).toBe('PASS');
    expect(result.healedLocatorCount).toBe(0);
    expect(result.steps.every((s) => s.status === 'passed')).toBe(true);
    expect(result.assertions.every((a) => a.status === 'passed')).toBe(true);
  });

  it('given_a_run_then_typed_values_actually_reach_the_fields', async () => {
    const driver = createFakeDriver({ url: 'https://app.test/login', elements: loginPage() });
    await executeIR(driver, loginIR());
    expect(driver.page().elements.find((e) => e.id === 'email')?.value).toBe('a@b.co');
  });
});

describe('failures stop the run and are attributable', () => {
  it('given_a_missing_element_then_the_step_fails_and_later_steps_are_skipped', async () => {
    const page = loginPage().filter((e) => e.id !== 'pw');
    const driver = createFakeDriver({ url: 'https://app.test/login', elements: page }, { timeoutMs: 40 });
    const result = await executeIR(driver, loginIR());

    expect(result.verdict).toBe('FAIL');
    const pwStep = result.steps.find((s) => s.order === 2);
    expect(pwStep?.status).toBe('failed');
    // Continuing past a failed step would test a state the test never described.
    expect(result.steps.find((s) => s.order === 3)?.status).toBe('skipped');
    expect(result.assertions.every((a) => a.status === 'skipped')).toBe(true);
  });

  it('given_a_failed_step_then_every_declared_step_still_appears_in_the_result', async () => {
    // A result listing fewer steps than the test has is unreadable.
    const driver = createFakeDriver({ elements: [] }, { timeoutMs: 30 });
    const result = await executeIR(driver, loginIR());
    expect(result.steps).toHaveLength(4);
    expect(result.steps.map((s) => s.order)).toEqual([0, 1, 2, 3]);
  });

  it('given_a_disabled_submit_button_then_the_error_names_the_failed_precondition', async () => {
    const page = loginPage().map((e) => (e.id === 'submit' ? { ...e, enabled: false } : e));
    const driver = createFakeDriver({ elements: page }, { timeoutMs: 40 });
    const result = await executeIR(driver, loginIR());
    expect(result.errorMessage).toMatch(/enabled/);
  });

  it('given_a_failing_assertion_then_all_assertions_still_report', async () => {
    // Each assertion is an independent question about the same final state.
    const driver = createFakeDriver({ url: 'https://app.test/login', elements: loginPage() });
    const result = await executeIR(
      driver,
      loginIR({
        assertions: [
          { order: 0, kind: 'url', expected: '/nowhere', description: 'Wrong URL expectation' },
          { order: 1, kind: 'visible', locator: fromTestId('welcome'), description: 'Welcome shown' },
        ],
      })
    );
    expect(result.verdict).toBe('FAIL');
    expect(result.assertions[0].status).toBe('failed');
    expect(result.assertions[1].status).toBe('passed');
  });
});

describe('heal reporting (§5)', () => {
  it('given_one_healed_locator_then_it_still_passes_but_the_heal_is_recorded', async () => {
    // testid absent, semantic present → resolution degrades one tier.
    const page = loginPage().map((e) => (e.id === 'email' ? { ...e, testid: undefined } : e));
    const driver = createFakeDriver({ elements: page });
    const ledger = createHealLedger();

    const ir = loginIR({
      steps: [
        { order: 0, action: 'navigate', value: 'https://app.test/login', description: 'Open' },
        {
          order: 1,
          action: 'type',
          locator: {
            testid: 'email',
            semantic: { role: 'textbox', name: 'Email' },
            preferredTier: 'testid',
          },
          value: 'a@b.co',
          description: 'Enter email',
        },
        { order: 2, action: 'click', locator: fromTestId('submit'), description: 'Sign in' },
      ],
    });

    const result = await executeIR(driver, ir, { healLedger: ledger, now: () => 100 });
    expect(result.verdict).toBe('PASS');
    expect(result.healedLocatorCount).toBe(1);
    expect(ledger.forTest('login-happy')).toHaveLength(1);
    expect(ledger.events()[0].from).toBe('testid');
    expect(ledger.events()[0].to).toBe('semantic');
  });

  it('given_two_healed_locators_then_the_pass_is_downgraded_to_NEEDS_REVIEW', async () => {
    // The core §5 guarantee: a pass built on multiple heals is not a clean pass.
    const page = loginPage().map((e) =>
      e.id === 'email' || e.id === 'submit' ? { ...e, testid: undefined } : e
    );
    const driver = createFakeDriver({ elements: page });

    const ir = loginIR({
      steps: [
        { order: 0, action: 'navigate', value: 'https://app.test/login', description: 'Open' },
        {
          order: 1,
          action: 'type',
          locator: {
            testid: 'email',
            semantic: { role: 'textbox', name: 'Email' },
            preferredTier: 'testid',
          },
          value: 'a@b.co',
          description: 'Enter email',
        },
        {
          order: 2,
          action: 'click',
          locator: {
            testid: 'submit',
            semantic: { role: 'button', name: 'Sign in' },
            preferredTier: 'testid',
          },
          description: 'Sign in',
        },
      ],
    });

    const result = await executeIR(driver, ir);
    expect(result.healedLocatorCount).toBe(2);
    expect(result.verdict).toBe('NEEDS_REVIEW');
  });
});

describe('captures and interpolation', () => {
  it('given_a_captured_value_then_a_later_step_uses_it', async () => {
    const driver = createFakeDriver({
      elements: [
        { id: 'order', tag: 'span', role: 'generic', testid: 'order-id', text: 'ORD-42' },
        { id: 'search', tag: 'input', role: 'textbox', name: 'Search', testid: 'search' },
      ],
    });

    const ir = parseTestIR({
      irVersion: IR_VERSION,
      id: 'capture-test',
      name: 'Order id can be searched',
      provenance: { source: 'user', generatedAt: 1 },
      steps: [
        {
          order: 0,
          action: 'capture',
          locator: fromTestId('order-id'),
          captureAs: 'orderId',
          captureFrom: 'text',
          description: 'Capture order id',
        },
        {
          order: 1,
          action: 'type',
          locator: fromTestId('search'),
          value: '{{orderId}}',
          description: 'Search for the order',
        },
      ],
      assertions: [
        { order: 0, kind: 'value', locator: fromTestId('search'), expected: 'ORD-42', description: 'Search box holds the id' },
      ],
    });

    const result = await executeIR(driver, ir);
    expect(result.verdict).toBe('PASS');
    expect(result.captured.orderId).toBe('ORD-42');
  });
});

describe('network assertions read the driver log', () => {
  it('given_an_observed_request_then_api_called_passes_and_api_not_called_fails', async () => {
    const driver = createFakeDriver({ elements: [{ id: 'x', tag: 'div', testid: 'x' }] });
    driver.emitResponse({
      requestId: '1',
      url: 'https://app.test/api/login',
      method: 'POST',
      status: 200,
    });

    const base = {
      irVersion: IR_VERSION,
      id: 'api',
      name: 'Login calls the API',
      provenance: { source: 'user', generatedAt: 1 },
      steps: [],
    };

    const called = await executeIR(
      driver,
      parseTestIR({
        ...base,
        assertions: [
          { order: 0, kind: 'api_called', expected: 'POST /api/login', description: 'Login API hit' },
        ],
      })
    );
    expect(called.verdict).toBe('PASS');

    const notCalled = await executeIR(
      driver,
      parseTestIR({
        ...base,
        assertions: [
          { order: 0, kind: 'api_not_called', expected: 'POST /api/login', description: 'Login API not hit' },
        ],
      })
    );
    expect(notCalled.verdict).toBe('FAIL');
  });

  it('given_a_status_mismatch_then_api_status_fails_and_reports_what_was_seen', async () => {
    const driver = createFakeDriver({ elements: [] });
    driver.emitResponse({ requestId: '1', url: 'https://app.test/api/x', method: 'POST', status: 500 });

    const result = await executeIR(
      driver,
      parseTestIR({
        irVersion: IR_VERSION,
        id: 'api2',
        name: 'API returns 200',
        provenance: { source: 'user', generatedAt: 1 },
        steps: [],
        assertions: [
          { order: 0, kind: 'api_status', expected: 'POST /api/x 200', description: 'Returns 200' },
        ],
      })
    );
    expect(result.verdict).toBe('FAIL');
    expect(result.errorMessage).toContain('500');
  });
});

describe('deterministic constraint tests run end to end', () => {
  it('given_generated_constraint_tests_then_they_execute_against_the_fake_driver', async () => {
    // Ties §9 to §6 to §2: zero-token generation produces real, runnable IR.
    const tests = generateConstraintTests({
      url: 'https://app.test/signup',
      formName: 'Signup',
      fields: [
        { selector: '#email', label: 'Email', type: 'email', name: 'email', required: true },
      ],
      submitLocator: fromTestId('submit'),
      now: 1,
    });
    expect(tests.length).toBeGreaterThan(0);

    const driver = createFakeDriver({
      url: 'https://app.test/signup',
      elements: [
        { id: 'email', tag: 'input', role: 'textbox', name: 'Email', css: '#email' },
        { id: 'submit', tag: 'button', role: 'button', name: 'Submit', testid: 'submit' },
      ],
    });

    // No success banner exists, so the "should not succeed" assertions hold.
    for (const ir of tests) {
      const result = await executeIR(driver, ir);
      expect(result.verdict).not.toBe('FAIL');
    }
  });
});

describe('testability report is fed by real usage', () => {
  it('given_a_run_using_css_only_locators_then_they_surface_as_gaps', async () => {
    const driver = createFakeDriver({
      elements: [{ id: 'btn', tag: 'button', role: 'button', name: 'Go', css: '.btn-primary' }],
    });

    const ir = parseTestIR({
      irVersion: IR_VERSION,
      id: 'gap',
      name: 'Click the button',
      startUrl: 'https://app.test/',
      provenance: { source: 'user', generatedAt: 1 },
      steps: [{ order: 0, action: 'click', locator: fromCss('.btn-primary'), description: 'Click Go' }],
      assertions: [
        { order: 0, kind: 'exists', locator: fromRole('button', 'Go'), description: 'Button exists' },
      ],
    });

    const result = await executeIR(driver, ir);
    const report = buildTestabilityReport(result.locatorUsages);
    expect(report.gaps).toHaveLength(1);
    expect(report.gaps[0].target).toBe('.btn-primary');
    expect(report.gaps[0].urls).toContain('https://app.test/');
  });
});

describe('abort', () => {
  it('given_an_aborted_signal_then_the_run_stops_and_marks_the_remainder_skipped', async () => {
    const driver = createFakeDriver({ elements: loginPage() });
    const result = await executeIR(driver, loginIR(), { signal: { aborted: true } });
    expect(result.verdict).toBe('FAIL');
    expect(result.errorMessage).toBe('Run aborted');
    expect(result.steps.every((s) => s.status === 'skipped')).toBe(true);
  });
});
