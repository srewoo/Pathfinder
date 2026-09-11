/**
 * T01 regression: a generated assertion must never leave a failing test green.
 *
 * The executor generates an assertion from the live DOM after a passing step,
 * runs it, and pushes the result into `stepResults`. It did not update the
 * attempt's failure flag, and the final status is derived from that flag alone —
 * so a generated assertion could fail while the test reported `passed`, with the
 * failed step visible inside a green result.
 *
 * `suggestAssertion` is injected here rather than built from an AI client, so
 * each case controls exactly what the generator returns and what running it does.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';

const MOCK_TAB_ID = 1;

vi.mock('../../src/messaging/messenger', () => ({
  getActiveTabId: vi.fn().mockResolvedValue(1),
  pingContentScript: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../src/core/explorer/page-scanner', () => ({
  getPageSnapshot: vi.fn(),
}));

vi.mock('../../src/core/knowledge/vector-search', () => ({
  searchByText: vi.fn().mockResolvedValue([]),
  formatSearchResults: vi.fn().mockReturnValue(''),
}));

vi.mock('../../src/core/planner/plan-cache', () => ({
  computePlanHash: vi.fn().mockResolvedValue('test-hash'),
  getCachedPlan: vi.fn().mockResolvedValue(undefined),
  cachePlan: vi.fn(async (tcId: string, hash: string, partial: { steps: unknown[] }) => ({
    id: 'plan-001',
    testCaseId: tcId,
    testCaseHash: hash,
    steps: partial.steps,
    cachedAt: new Date().toISOString(),
  })),
}));

vi.mock('../../src/utils/dom-compress', () => ({
  serializeCompressedDOM: vi.fn().mockReturnValue('<dom/>'),
}));

vi.mock('../../src/core/step-executor', () => ({
  executeStep: vi.fn().mockResolvedValue({ success: true }),
  canExecuteStep: vi.fn().mockReturnValue(true),
  releaseTab: vi.fn(),
  evaluateInTab: vi.fn().mockResolvedValue(undefined),
  driverForTab: vi.fn(() => {
    throw new Error('no driver in this test');
  }),
}));

vi.mock('../../src/core/executor/action-runner', () => ({
  runStep: vi.fn(),
  navigateTab: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/core/cdp/cdp-session', () => ({
  initCDPSession: vi.fn().mockResolvedValue(false),
  teardownCDPSession: vi.fn().mockResolvedValue([]),
  getAXContext: vi.fn().mockResolvedValue(undefined),
  getCurrentHAR: vi.fn().mockReturnValue([]),
  captureFullPageScreenshot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/core/cdp/cdp-client', () => ({
  captureFullPageScreenshot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/core/explorer/interaction-graph', () => ({
  loadGraph: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/core/healing/self-healer', () => ({
  healStep: vi.fn(),
  registerHealedSelector: vi.fn(),
}));

vi.mock('../../src/core/executor/auth-manager', () => ({
  ensureAuthenticated: vi.fn().mockResolvedValue({ authenticated: true, method: 'none' }),
  recoverSessionIfExpired: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../src/utils/screenshot', () => ({
  captureTab: vi.fn().mockResolvedValue(undefined),
}));

vi.stubGlobal('chrome', {
  tabs: {
    get: vi.fn().mockResolvedValue({ url: 'https://app.example.com' }),
    create: vi.fn().mockImplementation(async () => ({ id: 20 })),
    remove: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
  },
});

import { executeTest } from '../../src/core/executor/test-executor';
import { testCaseDB, testResultDB } from '../../src/storage/indexed-db';
import { getPageSnapshot } from '../../src/core/explorer/page-scanner';
import { runStep } from '../../src/core/executor/action-runner';
import type {
  TestCase,
  ExecutionStep,
  StepResult,
  ExecutionPlan,
} from '../../src/storage/schemas';
import type { ExecutionServices, AssertionSuggester } from '../../src/core/executor/execution-ports';

/** One action step, so the generated assertion is the only other thing that runs. */
const PLAN_STEPS: ExecutionStep[] = [
  { order: 1, action: 'click', selector: '#save', description: 'Click save' },
];

/** The assertion the generator offers after step 1 passes. */
const GENERATED_ASSERTION: ExecutionStep = {
  order: 0,
  action: 'assert',
  selector: '.saved-banner',
  assertType: 'visible',
  description: 'Saved banner is visible',
};

function testCase(): TestCase {
  return {
    id: 'tc-assert',
    title: 'User can save',
    description: 'Verify saving works',
    type: 'positive',
    source: 'generated',
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
}

function plan(): ExecutionPlan {
  return {
    id: 'plan-assert',
    testCaseId: 'tc-assert',
    testCaseHash: 'h',
    steps: PLAN_STEPS,
    cachedAt: new Date().toISOString(),
  };
}

function servicesWith(suggestAssertion?: AssertionSuggester): ExecutionServices {
  return { plan: async () => plan(), suggestAssertion };
}

const passed = (step: ExecutionStep): StepResult => ({ step, status: 'passed', duration: 10 });
const failed = (step: ExecutionStep, error: string): StepResult => ({
  step,
  status: 'failed',
  duration: 10,
  error,
});

/** Run with generated assertions enabled — the mode this regression is about. */
function run(services: ExecutionServices) {
  return executeTest(testCase(), services, MOCK_TAB_ID, { useAIAssertions: true });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await testCaseDB.clear();
  await testResultDB.clear();
  vi.mocked(getPageSnapshot).mockResolvedValue({
    url: 'https://app.example.com/form',
    title: 'Form',
    elements: [],
    domCompressed: '<form/>',
    capturedAt: new Date().toISOString(),
  });
});

describe('a generated assertion that fails', () => {
  /** Action passes; the generated assertion fails. */
  function assertionFails() {
    vi.mocked(runStep).mockImplementation(async (step) =>
      step.action === 'assert' ? failed(step, 'Element .saved-banner not visible') : passed(step)
    );
    return servicesWith(async () => ({ ...GENERATED_ASSERTION }));
  }

  it('given_a_failed_generated_assertion_then_the_test_does_not_pass', async () => {
    const result = await run(assertionFails());
    expect(result.status).not.toBe('passed');
  });

  it('given_a_failed_generated_assertion_then_the_test_is_failed', async () => {
    const result = await run(assertionFails());
    expect(result.status).toBe('failed');
  });

  // Without this the result carried a visibly failed step inside a green test,
  // which reads as a UI bug rather than a real failure.
  it('given_a_failed_generated_assertion_then_the_failing_step_is_in_the_result', async () => {
    const result = await run(assertionFails());
    const assertion = result.steps.find((s) => s.step.action === 'assert');
    expect(assertion?.status).toBe('failed');
    expect(assertion?.error).toContain('.saved-banner');
  });

  // T01 acceptance: the failure UI and exports must be able to name it.
  it('given_a_failed_generated_assertion_then_the_error_message_says_an_assertion_failed', async () => {
    const result = await run(assertionFails());
    expect(result.errorMessage).toBeTruthy();
    expect(result.errorMessage).toMatch(/assertion/i);
  });

  // A generation gap and a product defect are different things; the message must
  // not make an auto-added check look like a step the user wrote.
  it('given_a_failed_generated_assertion_then_it_is_identified_as_generated', async () => {
    const result = await run(assertionFails());
    expect(result.errorMessage).toMatch(/generated|auto/i);
  });
});

describe('a generated assertion that passes', () => {
  it('given_a_passing_generated_assertion_then_the_test_still_passes', async () => {
    vi.mocked(runStep).mockImplementation(async (step) => passed(step));
    const result = await run(servicesWith(async () => ({ ...GENERATED_ASSERTION })));

    expect(result.status).toBe('passed');
    expect(result.steps.some((s) => s.step.action === 'assert')).toBe(true);
  });
});

describe('generation unavailable', () => {
  // Absence of a capability is a supported mode, not a failure.
  it('given_no_suggester_then_the_test_passes_and_no_assertion_is_invented', async () => {
    vi.mocked(runStep).mockImplementation(async (step) => passed(step));
    const result = await run(servicesWith(undefined));

    expect(result.status).toBe('passed');
    expect(result.steps.every((s) => s.step.action !== 'assert')).toBe(true);
  });

  it('given_the_suggester_returns_null_then_the_test_passes_with_no_assertion', async () => {
    vi.mocked(runStep).mockImplementation(async (step) => passed(step));
    const result = await run(servicesWith(async () => null));

    expect(result.status).toBe('passed');
    expect(result.steps.every((s) => s.step.action !== 'assert')).toBe(true);
  });

  // Generation being broken must not fail the test, and must not fabricate a
  // successful assertion either.
  it('given_the_suggester_throws_then_the_test_passes_and_nothing_is_recorded', async () => {
    vi.mocked(runStep).mockImplementation(async (step) => passed(step));
    const result = await run(
      servicesWith(async () => {
        throw new Error('model unavailable');
      })
    );

    expect(result.status).toBe('passed');
    expect(result.steps.every((s) => s.step.action !== 'assert')).toBe(true);
  });
});

describe('a generated assertion that could not be run', () => {
  // The generator produced a check and running it errored. Discarding that
  // silently claims a clean pass for a check whose answer is unknown.
  it('given_running_the_assertion_throws_then_the_test_does_not_pass_silently', async () => {
    vi.mocked(runStep).mockImplementation(async (step) => {
      if (step.action === 'assert') throw new Error('tab detached');
      return passed(step);
    });
    const result = await run(servicesWith(async () => ({ ...GENERATED_ASSERTION })));

    // Either it is recorded as a failed/unknown step, or the test is not green —
    // what it must never be is a green result with the check simply missing.
    const assertionStep = result.steps.find((s) => s.step.action === 'assert');
    expect(
      result.status !== 'passed' || assertionStep !== undefined
    ).toBe(true);
  });
});

describe('cancellation is unchanged', () => {
  it('given_an_aborted_signal_then_the_test_fails_for_cancellation_not_for_an_assertion', async () => {
    vi.mocked(runStep).mockImplementation(async (step) => passed(step));
    const controller = new AbortController();
    controller.abort();

    const result = await executeTest(testCase(), servicesWith(async () => ({ ...GENERATED_ASSERTION })), MOCK_TAB_ID, {
      useAIAssertions: true,
      signal: controller.signal,
    });

    expect(result.status).toBe('failed');
    expect(result.errorMessage).toMatch(/abort|stopped|ceiling/i);
  });
});
