/**
 * IR execution path (fix.md §6).
 *
 * Two things must hold for this path to be worth having:
 *
 *   EQUIVALENCE — the same test reaches the same verdict as the legacy walker
 *   REFUSAL     — it declines rather than silently running a DIFFERENT test
 *
 * The second matters more. A plan containing `if_visible` or `loop` has no IR
 * representation; executing the remainder would run something the author never
 * wrote and report it as a pass.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  evaluateIrPath,
  executeViaIr,
  explainPathChoice,
} from '../../src/core/executor/ir-execution-path';
import { registerStepExecutor, clearStepExecutor } from '../../src/core/step-executor';
import { createFakeDriver, type FakeElement } from '../../src/drivers/fake-driver';
import type { ExecutionPlan, ExecutionStep, TestCase } from '../../src/storage/schemas';

const TAB = 11;

const testCase = (over: Partial<TestCase> = {}): TestCase =>
  ({
    id: 'tc-1',
    title: 'User can sign in',
    description: 'signs in',
    startUrl: 'https://app.test/login',
    status: 'pending',
    type: 'positive',
    ...over,
  }) as TestCase;

const plan = (steps: ExecutionStep[]): ExecutionPlan => ({
  id: 'p1',
  testCaseId: 'tc-1',
  testCaseHash: 'h',
  steps,
  cachedAt: new Date(0).toISOString(),
});

const loginSteps = (): ExecutionStep[] => [
  { order: 0, action: 'navigate', value: 'https://app.test/login', description: 'Open login' },
  { order: 1, action: 'type', selector: '#email', value: 'a@b.co', description: 'Enter email' },
  { order: 2, action: 'click', selector: '#submit', description: 'Click Sign in' },
  {
    order: 3,
    action: 'assert',
    selector: '#welcome',
    assertType: 'visible',
    description: 'Welcome shown',
  },
];

function loginPage(): FakeElement[] {
  return [
    { id: 'email', tag: 'input', role: 'textbox', name: 'Email', css: '#email' },
    {
      id: 'submit',
      tag: 'button',
      role: 'button',
      name: 'Sign in',
      css: '#submit',
      onClick: (page) => {
        page.elements.push({
          id: 'welcome',
          tag: 'h1',
          role: 'heading',
          name: 'Welcome',
          css: '#welcome',
          text: 'Welcome',
        });
      },
    },
  ];
}

/** Register a fake driver behind the port, as the driver layer would. */
function useFakeDriver(elements: FakeElement[]) {
  const driver = createFakeDriver({ url: 'https://app.test/login', elements }, { timeoutMs: 200, pollMs: 5 });
  registerStepExecutor(
    async () => ({ success: true }),
    () => true,
    () => undefined,
    (async () => undefined) as never,
    () => driver
  );
  return driver;
}

beforeEach(() => {
  clearStepExecutor();
});

describe('the IR path refuses rather than running a different test', () => {
  it('given_a_plan_with_a_loop_step_then_it_declines_and_names_the_reason', () => {
    // `loop` has no IR representation. Executing the rest would silently drop
    // control flow the author wrote.
    const d = evaluateIrPath(
      testCase(),
      plan([
        { order: 0, action: 'loop', loopCount: 3, description: 'Repeat three times' },
        ...loginSteps(),
      ])
    );
    expect(d.usable).toBe(false);
    if (!d.usable) expect(d.reason).toMatch(/drop 1 step/);
  });

  it('given_a_plan_with_a_conditional_then_it_declines', () => {
    const d = evaluateIrPath(
      testCase(),
      plan([{ order: 0, action: 'if_visible', selector: '#maybe', description: 'Maybe click' }, ...loginSteps()])
    );
    expect(d.usable).toBe(false);
  });

  it('given_a_plan_with_a_legacy_wait_then_it_declines_because_the_step_would_vanish', () => {
    // `wait` is intentionally absent from the IR (§8), so a plan containing one
    // cannot round-trip. Declining is right; silently dropping it is not.
    const d = evaluateIrPath(
      testCase(),
      plan([{ order: 0, action: 'wait', value: '2000', description: 'Wait 2s' }, ...loginSteps()])
    );
    expect(d.usable).toBe(false);
  });

  it('given_a_plan_with_no_assertions_then_it_declines', () => {
    // A test that asserts nothing always passes — the IR gate catches it here
    // rather than letting it run and report green.
    const d = evaluateIrPath(
      testCase(),
      plan([{ order: 0, action: 'click', selector: '#go', description: 'Go' }])
    );
    expect(d.usable).toBe(false);
    if (!d.usable) expect(d.reason).toMatch(/no assertions/);
  });

  it('given_a_clean_plan_then_it_accepts_and_says_so', () => {
    const d = evaluateIrPath(testCase(), plan(loginSteps()));
    expect(d.usable).toBe(true);
    expect(explainPathChoice(d, 'User can sign in')).toMatch(/runs on the IR path/);
  });

  it('given_a_refusal_then_the_explanation_names_the_legacy_fallback', () => {
    const d = evaluateIrPath(testCase(), plan([{ order: 0, action: 'loop', description: 'x' }]));
    expect(explainPathChoice(d, 'T')).toMatch(/runs on the legacy path/);
  });
});

describe('equivalence: the IR path reaches the right verdict', () => {
  it('given_a_passing_test_then_it_passes', async () => {
    useFakeDriver(loginPage());
    const d = evaluateIrPath(testCase(), plan(loginSteps()));
    expect(d.usable).toBe(true);
    if (!d.usable) return;

    const result = await executeViaIr(testCase(), d.ir, TAB, { runId: 'r1' });
    expect(result.status).toBe('passed');
    expect(result.steps.some((s) => s.status === 'failed')).toBe(false);
  });

  it('given_a_missing_element_then_it_fails_and_names_the_step', async () => {
    // Same defect the legacy walker would catch, same verdict.
    useFakeDriver(loginPage().filter((e) => e.id !== 'submit'));
    const d = evaluateIrPath(testCase(), plan(loginSteps()));
    if (!d.usable) throw new Error('expected the plan to convert');

    const result = await executeViaIr(testCase(), d.ir, TAB, { runId: 'r1' });
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toBeTruthy();
  });

  it('given_a_failing_assertion_then_it_fails', async () => {
    // Submit exists but never reveals the welcome heading.
    const page = loginPage().map((e) => (e.id === 'submit' ? { ...e, onClick: undefined } : e));
    useFakeDriver(page);
    const d = evaluateIrPath(testCase(), plan(loginSteps()));
    if (!d.usable) throw new Error('expected the plan to convert');

    const result = await executeViaIr(testCase(), d.ir, TAB, { runId: 'r1' });
    expect(result.status).toBe('failed');
  });

  it('given_a_result_then_its_shape_matches_what_storage_and_reports_expect', async () => {
    // The whole point of normalising: callers, storage and exporters need no
    // special case for which engine ran.
    useFakeDriver(loginPage());
    const d = evaluateIrPath(testCase(), plan(loginSteps()));
    if (!d.usable) throw new Error('expected the plan to convert');

    const result = await executeViaIr(testCase(), d.ir, TAB, { runId: 'run-42' });
    expect(result.testCaseId).toBe('tc-1');
    expect(result.testCaseTitle).toBe('User can sign in');
    expect(result.runId).toBe('run-42');
    expect(result.startedAt).toBeTruthy();
    expect(result.completedAt).toBeTruthy();
    expect(Array.isArray(result.steps)).toBe(true);
    expect(Array.isArray(result.healingAttempts)).toBe(true);
    // Assertions appear as steps, so the UI renders them without a new branch.
    expect(result.steps.some((s) => s.step.action === 'assert')).toBe(true);
  });

  it('given_an_aborted_signal_then_it_stops_and_fails_rather_than_reporting_a_pass', async () => {
    useFakeDriver(loginPage());
    const d = evaluateIrPath(testCase(), plan(loginSteps()));
    if (!d.usable) throw new Error('expected the plan to convert');

    const result = await executeViaIr(testCase(), d.ir, TAB, {
      runId: 'r1',
      signal: { aborted: true },
    });
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toMatch(/aborted/i);
  });
});

describe('negative tests convert correctly', () => {
  it('given_a_negative_test_then_it_still_converts_and_runs', async () => {
    // The enricher emits `api_not_called` for negative tests; that must survive
    // conversion, since it is the strongest assertion in the suite.
    const negative = testCase({ type: 'negative', title: 'Login rejects an invalid email' });
    const steps: ExecutionStep[] = [
      { order: 0, action: 'navigate', value: 'https://app.test/login', description: 'Open' },
      { order: 1, action: 'type', selector: '#email', value: 'bad', description: 'Bad email' },
      { order: 2, action: 'click', selector: '#submit', description: 'Submit' },
      {
        order: 3,
        action: 'assert',
        assertType: 'api_not_called',
        assertExpected: 'POST /api/login',
        description: 'No login request is made',
      },
    ];
    const d = evaluateIrPath(negative, plan(steps));
    expect(d.usable).toBe(true);
    if (!d.usable) return;
    expect(d.ir.assertions[0].kind).toBe('api_not_called');

    useFakeDriver(loginPage());
    const result = await executeViaIr(negative, d.ir, TAB, { runId: 'r1' });
    // No request was made by the fake driver, so the assertion holds.
    expect(result.status).toBe('passed');
  });
});
