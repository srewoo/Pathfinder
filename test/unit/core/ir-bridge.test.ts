/**
 * Legacy → IR conversion (fix.md §6).
 *
 * The migration seam. Two properties matter most: mid-flow assertion semantics
 * must survive, and anything that cannot be represented must be REPORTED rather
 * than silently dropped — a step that vanishes in conversion is a test that
 * quietly stops checking something.
 */
import { describe, it, expect } from 'vitest';
import {
  describeDropped,
  irToExecutionSteps,
  locatorOf,
  testCaseToIR,
} from '../../../src/core/ir/ir-bridge';
import { serializeIR } from '../../../src/core/ir/test-ir';
import type { ExecutionStep, TestCase } from '../../../src/storage/schemas';

const testCase = (over: Partial<TestCase> = {}): TestCase =>
  ({
    id: 'tc-1',
    title: 'User can sign in',
    description: 'signs in',
    startUrl: 'https://app.test/login',
    status: 'pending',
    ...over,
  }) as TestCase;

const steps = (...s: ExecutionStep[]) => s;

describe('action conversion', () => {
  it('given_ordinary_actions_then_they_map_to_IR_steps', () => {
    const { ir, errors } = testCaseToIR(
      testCase(),
      steps(
        { order: 0, action: 'navigate', value: 'https://app.test/login', description: 'Open' },
        { order: 1, action: 'type', selector: '#email', value: 'a@b.co', description: 'Email' },
        { order: 2, action: 'click', selector: '#go', description: 'Submit' },
        { order: 3, action: 'assert', selector: '.ok', assertType: 'visible', description: 'OK' }
      )
    );
    expect(errors).toEqual([]);
    expect(ir?.steps.map((s) => s.action)).toEqual(['navigate', 'type', 'click']);
    expect(ir?.assertions).toHaveLength(1);
  });

  it('given_capture_value_then_it_becomes_a_capture_step', () => {
    const { ir } = testCaseToIR(
      testCase(),
      steps(
        {
          order: 0,
          action: 'capture_value',
          selector: '#id',
          captureName: 'orderId',
          captureSource: 'text',
          description: 'Capture',
        },
        { order: 1, action: 'assert', selector: '.ok', assertType: 'visible', description: 'OK' }
      )
    );
    expect(ir?.steps[0].action).toBe('capture');
    expect(ir?.steps[0].captureAs).toBe('orderId');
  });

  it('given_use_captured_then_the_variable_survives_as_interpolation', () => {
    // The action is dropped but the substitution is preserved — otherwise the
    // value would be lost entirely.
    const { ir } = testCaseToIR(
      testCase(),
      steps(
        {
          order: 0,
          action: 'capture_value',
          selector: '#id',
          captureName: 'orderId',
          description: 'Capture',
        },
        { order: 1, action: 'type', selector: '#q', value: '{{orderId}}', description: 'Search' },
        { order: 2, action: 'assert', selector: '.ok', assertType: 'visible', description: 'OK' }
      )
    );
    expect(ir?.steps[1].value).toBe('{{orderId}}');
  });
});

describe('unrepresentable constructs are reported, never silent', () => {
  it('given_a_wait_step_then_it_is_dropped_with_a_reason', () => {
    const { ir, dropped } = testCaseToIR(
      testCase(),
      steps(
        { order: 0, action: 'wait', value: '3000', description: 'Wait' },
        { order: 1, action: 'click', selector: '#go', description: 'Go' },
        { order: 2, action: 'assert', selector: '.ok', assertType: 'visible', description: 'OK' }
      )
    );
    expect(ir?.steps).toHaveLength(1);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].reason).toMatch(/actionability/);
  });

  it('given_control_flow_actions_then_each_is_reported', () => {
    const { dropped } = testCaseToIR(
      testCase(),
      steps(
        { order: 0, action: 'if_visible', selector: '#x', description: 'Maybe' },
        { order: 1, action: 'loop', loopCount: 3, description: 'Repeat' },
        { order: 2, action: 'click', selector: '#go', description: 'Go' },
        { order: 3, action: 'assert', selector: '.ok', assertType: 'visible', description: 'OK' }
      )
    );
    expect(dropped.map((d) => d.action)).toEqual(['if_visible', 'loop']);
    expect(describeDropped(dropped)).toMatch(/vocabulary/);
  });

  it('given_an_unknown_assertType_then_it_is_reported_not_coerced', () => {
    // Coercing to a default would invent an assertion the author never wrote.
    const { dropped } = testCaseToIR(
      testCase(),
      steps(
        { order: 0, action: 'assert', selector: '.x', assertType: 'telepathy' as never, description: 'Odd' },
        { order: 1, action: 'assert', selector: '.ok', assertType: 'visible', description: 'OK' }
      )
    );
    expect(dropped[0].reason).toMatch(/unknown assertType/);
  });
});

describe('mid-flow assertion semantics', () => {
  it('given_an_assertion_between_actions_then_it_is_pinned_to_the_preceding_step', () => {
    // Deferring it to the end would check a page the test never claimed anything
    // about.
    const { ir } = testCaseToIR(
      testCase(),
      steps(
        { order: 0, action: 'click', selector: '#save', description: 'Save' },
        { order: 1, action: 'assert', selector: '.toast', assertType: 'visible', description: 'Toast' },
        { order: 2, action: 'navigate', value: 'https://app.test/next', description: 'Leave' },
        { order: 3, action: 'assert', assertType: 'url', assertExpected: '/next', description: 'URL' }
      )
    );
    expect(ir?.assertions[0].afterStep).toBe(0);
    expect(ir?.assertions[1].afterStep).toBe(1);
  });

  it('given_a_leading_assertion_then_it_has_no_pinned_step', () => {
    const { ir } = testCaseToIR(
      testCase(),
      steps(
        { order: 0, action: 'assert', selector: '.login', assertType: 'visible', description: 'On login' },
        { order: 1, action: 'click', selector: '#go', description: 'Go' }
      )
    );
    expect(ir?.assertions[0].afterStep).toBeUndefined();
  });
});

describe('validation still applies at the boundary', () => {
  it('given_a_plan_with_no_assertions_then_conversion_fails_loudly', () => {
    // §6: a test that asserts nothing always passes.
    const { ir, errors } = testCaseToIR(
      testCase(),
      steps({ order: 0, action: 'click', selector: '#go', description: 'Go' })
    );
    expect(ir).toBeNull();
    expect(errors.join()).toMatch(/no assertions/);
  });

  it('given_a_click_with_no_selector_then_conversion_fails', () => {
    const { ir, errors } = testCaseToIR(
      testCase(),
      steps(
        { order: 0, action: 'click', description: 'Go nowhere' },
        { order: 1, action: 'assert', selector: '.ok', assertType: 'visible', description: 'OK' }
      )
    );
    expect(ir).toBeNull();
    expect(errors.join()).toMatch(/requires a locator/);
  });
});

describe('locatorOf', () => {
  it('given_a_testid_selector_then_it_is_promoted_to_the_testid_tier', () => {
    // Leaving it structural would understate testability and forgo the more
    // robust resolution path.
    const loc = locatorOf('[data-testid="save"]');
    expect(loc.preferredTier).toBe('testid');
    expect(loc.testid).toBe('save');
    expect(loc.structural?.css).toBe('[data-testid="save"]');
  });

  it('given_a_plain_css_selector_then_it_stays_structural', () => {
    expect(locatorOf('.btn-primary').preferredTier).toBe('structural');
  });
});

describe('round trip', () => {
  it('given_a_plan_then_IR_and_back_preserves_order_and_interleaving', () => {
    const original = steps(
      { order: 0, action: 'navigate', value: 'https://app.test/', description: 'Open' },
      { order: 1, action: 'click', selector: '#save', description: 'Save' },
      { order: 2, action: 'assert', selector: '.toast', assertType: 'visible', description: 'Toast' },
      { order: 3, action: 'click', selector: '#next', description: 'Next' },
      { order: 4, action: 'assert', assertType: 'url', assertExpected: '/done', description: 'URL' }
    );
    const { ir } = testCaseToIR(testCase(), original);
    const back = irToExecutionSteps(ir!);

    expect(back.map((s) => s.action)).toEqual([
      'navigate',
      'click',
      'assert',
      'click',
      'assert',
    ]);
    expect(back.map((s) => s.order)).toEqual([0, 1, 2, 3, 4]);
    expect(back[2].assertType).toBe('visible');
  });

  it('given_two_conversions_of_the_same_plan_then_the_IR_is_byte_identical', () => {
    const plan = steps(
      { order: 0, action: 'click', selector: '#go', description: 'Go' },
      { order: 1, action: 'assert', selector: '.ok', assertType: 'visible', description: 'OK' }
    );
    const a = testCaseToIR(testCase(), plan, { now: 1 }).ir!;
    const b = testCaseToIR(testCase(), plan, { now: 1 }).ir!;
    expect(serializeIR(a)).toBe(serializeIR(b));
  });
});
