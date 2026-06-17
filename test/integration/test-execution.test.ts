/**
 * Integration test: Test Execution pipeline
 *
 * Tests the flow: executeTest → planTest → runStep (→ healStep on failure) → TestResult
 * Mocked: AI client, DOM action runner, screenshot capture, Chrome messaging.
 * IndexedDB uses fake-indexeddb for real in-memory persistence.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';

// Use literal — vi.mock factories are hoisted before const declarations
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
  cachePlan: vi.fn(async (_tcId: string, hash: string, partial: { steps: unknown[] }) => ({
    id: 'plan-001',
    testCaseId: _tcId,
    testCaseHash: hash,
    steps: partial.steps,
    cachedAt: new Date().toISOString(),
  })),
}));

vi.mock('../../src/utils/dom-compress', () => ({
  serializeCompressedDOM: vi.fn().mockReturnValue('<dom/>'),
}));

vi.mock('../../src/core/executor/action-runner', () => ({
  runStep: vi.fn(),
  navigateTab: vi.fn().mockResolvedValue(undefined),
}));

// Neutralize CDP — these tests exercise the synthetic-runner path. initCDPSession
// returns false so executeTest uses runStep (mocked above).
vi.mock('../../src/core/cdp/cdp-action-runner', () => ({
  initCDPSession: vi.fn().mockResolvedValue(false),
  teardownCDPSession: vi.fn().mockResolvedValue([]),
  runStepWithCDP: vi.fn(),
  getAXContext: vi.fn().mockResolvedValue(undefined),
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

// Mock chrome.tabs for getCurrentTabUrl, parallel tab pool, and the module-load
// onRemoved listener registered by cdp-client.
const chromeMock = {
  tabs: {
    get: vi.fn().mockResolvedValue({ url: 'https://app.example.com' }),
    create: vi.fn().mockImplementation(async () => ({ id: Math.floor(Math.random() * 1000) + 10 })),
    remove: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
  },
};
vi.stubGlobal('chrome', chromeMock);

import { executeTest, executeAllTests } from '../../src/core/executor/test-executor';
import { testCaseDB, testResultDB } from '../../src/storage/indexed-db';
import { getPageSnapshot } from '../../src/core/explorer/page-scanner';
import { runStep } from '../../src/core/executor/action-runner';
import { healStep } from '../../src/core/healing/self-healer';
import { recoverSessionIfExpired } from '../../src/core/executor/auth-manager';
import { configureBudget, BudgetExceededError } from '../../src/core/ai/budget-guard';
import type { TestCase, ExecutionStep, StepResult, HealingAttempt } from '../../src/storage/schemas';

const mockPlanSteps: ExecutionStep[] = [
  { order: 1, action: 'click', selector: '#login-btn', description: 'Click login' },
  { order: 2, action: 'type', selector: '#email', value: 'user@test.com', description: 'Enter email' },
  { order: 3, action: 'assert', selector: '.dashboard', assertType: 'visible', description: 'Dashboard visible' },
];

const validAIPlanResponse = JSON.stringify({ steps: mockPlanSteps });

const mockAIClient = {
  chat: vi.fn().mockResolvedValue(validAIPlanResponse),
  embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
};

function makeTestCase(id = 'tc-001'): TestCase {
  return {
    id,
    title: 'User can log in',
    description: 'Verify a valid user can log in',
    type: 'positive',
    source: 'generated',
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
}

function makePassedStep(step: ExecutionStep): StepResult {
  return { step, status: 'passed', duration: 120 };
}

function makeFailedStep(step: ExecutionStep, error = 'Element not found'): StepResult {
  return { step, status: 'failed', duration: 50, error };
}

describe('executeTest', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await testCaseDB.clear();
    await testResultDB.clear();

    mockAIClient.chat.mockResolvedValue(validAIPlanResponse);
    mockAIClient.embed.mockResolvedValue([0.1, 0.2, 0.3]);

    vi.mocked(getPageSnapshot).mockResolvedValue({
      url: 'https://app.example.com/login',
      title: 'Login',
      elements: [],
      domCompressed: '<form/>',
      capturedAt: new Date().toISOString(),
    });

    vi.mocked(runStep).mockImplementation(async (step) => makePassedStep(step));
  });

  it('given valid test case when all steps pass then result status is passed', async () => {
    const tc = makeTestCase();
    const result = await executeTest(tc, mockAIClient as never, MOCK_TAB_ID);

    expect(result.status).toBe('passed');
    expect(result.steps).toHaveLength(3);
    expect(result.steps.every((s) => s.status === 'passed')).toBe(true);
    expect(result.testCaseId).toBe('tc-001');
  });

  it('given step fails when no healing succeeds then result status is failed', async () => {
    // #login-btn fails on original, quick-retry, AND healed attempts.
    vi.mocked(runStep).mockImplementation(async (step) => {
      if (step.selector === '#login-btn') return makeFailedStep(step);
      return makePassedStep(step);
    });

    const failedAttempt: HealingAttempt = {
      stepOrder: 1,
      originalSelector: '#login-btn',
      method: 'similarity',
      success: false,
    };
    vi.mocked(healStep).mockResolvedValue({
      success: false,
      attempt: failedAttempt,
    });

    const tc = makeTestCase();
    const result = await executeTest(tc, mockAIClient as never, MOCK_TAB_ID);

    expect(result.status).toBe('failed');
    expect(result.steps.find((s) => s.step.selector === '#login-btn')?.status).toBe('failed');
    expect(result.steps.filter((s) => s.status === 'skipped').length).toBeGreaterThan(0);
  }, 20000);

  it('given step fails when healing succeeds then result status is passed', async () => {
    // Original + quick-retry both fail (still #login-btn); only the HEALED
    // selector passes — so healing is genuinely exercised.
    vi.mocked(runStep).mockImplementation(async (step) =>
      step.selector === '#login-btn' ? makeFailedStep(step, 'Element not found') : makePassedStep(step)
    );

    const healedStep: ExecutionStep = { ...mockPlanSteps[0], selector: 'button.login-btn' };
    const successAttempt: HealingAttempt = {
      stepOrder: 1,
      originalSelector: '#login-btn',
      method: 'similarity',
      healedSelector: 'button.login-btn',
      success: true,
    };
    vi.mocked(healStep).mockResolvedValue({
      success: true,
      healedStep,
      attempt: successAttempt,
    });

    const tc = makeTestCase();
    const result = await executeTest(tc, mockAIClient as never, MOCK_TAB_ID);

    expect(result.status).toBe('passed');
    expect(result.healingAttempts).toHaveLength(1);
    expect(result.healingAttempts[0].method).toBe('similarity');
  });

  it('given planning fails when executing then result status is error', async () => {
    mockAIClient.chat.mockRejectedValue(new Error('API unavailable'));

    const tc = makeTestCase();
    const result = await executeTest(tc, mockAIClient as never, MOCK_TAB_ID);

    expect(result.status).toBe('error');
    expect(result.errorMessage).toContain('API unavailable');
    expect(result.steps).toHaveLength(0);
  });

  it('given test execution when complete then result persisted to IndexedDB', async () => {
    vi.mocked(runStep).mockImplementation(async (step) => makePassedStep(step));

    const tc = makeTestCase('tc-persist');
    await testCaseDB.put(tc);
    await executeTest(tc, mockAIClient as never, MOCK_TAB_ID);

    const results = await testResultDB.getAll();
    expect(results.some((r) => r.testCaseId === 'tc-persist')).toBe(true);
  });

  it('given test execution when complete then test case status updated in IndexedDB', async () => {
    vi.mocked(runStep).mockImplementation(async (step) => makePassedStep(step));

    const tc = makeTestCase('tc-status');
    await testCaseDB.put(tc);
    await executeTest(tc, mockAIClient as never, MOCK_TAB_ID);

    const saved = await testCaseDB.get('tc-status');
    expect(saved?.status).toBe('passed');
  });

  it('given step without selector when step fails then skips healing and marks failed', async () => {
    const stepNoSelector: ExecutionStep = { order: 1, action: 'navigate', value: '/bad-path', description: 'Navigate' };
    mockAIClient.chat.mockResolvedValue(JSON.stringify({ steps: [stepNoSelector] }));
    vi.mocked(runStep).mockResolvedValue(makeFailedStep(stepNoSelector));

    const tc = makeTestCase('tc-no-sel');
    const result = await executeTest(tc, mockAIClient as never, MOCK_TAB_ID);

    expect(result.status).toBe('failed');
    expect(healStep).not.toHaveBeenCalled();
  });

  it('given onStepResult callback when step completes then callback is invoked per step', async () => {
    vi.mocked(runStep).mockImplementation(async (step) => makePassedStep(step));
    const onStepResult = vi.fn();

    const tc = makeTestCase();
    await executeTest(tc, mockAIClient as never, MOCK_TAB_ID, { onStepResult });

    expect(onStepResult).toHaveBeenCalledTimes(3);
    expect(onStepResult).toHaveBeenCalledWith('tc-001', expect.any(Number), expect.objectContaining({ status: 'passed' }));
  });
});

describe('executeAllTests', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await testCaseDB.clear();
    await testResultDB.clear();

    mockAIClient.chat.mockResolvedValue(validAIPlanResponse);
    vi.mocked(getPageSnapshot).mockResolvedValue({
      url: 'https://app.example.com',
      title: 'App',
      elements: [],
      domCompressed: '<div/>',
      capturedAt: new Date().toISOString(),
    });
    vi.mocked(runStep).mockImplementation(async (step) => makePassedStep(step));
  });

  it('given multiple pending test cases when executeAllTests then returns result for each', async () => {
    await testCaseDB.put(makeTestCase('tc-a'));
    await testCaseDB.put(makeTestCase('tc-b'));

    const results = await executeAllTests(mockAIClient as never);

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === 'passed')).toBe(true);
  });

  it('given no test cases when executeAllTests then returns empty array', async () => {
    const results = await executeAllTests(mockAIClient as never);
    expect(results).toEqual([]);
  });

  it('given multiple test cases when run then all share the same runId', async () => {
    await testCaseDB.put(makeTestCase('tc-1'));
    await testCaseDB.put(makeTestCase('tc-2'));

    const results = await executeAllTests(mockAIClient as never);

    expect(results[0].runId).toBe(results[1].runId);
  });

  it('given already-passed tests when executeAllTests then skips them by default', async () => {
    const passed = { ...makeTestCase('tc-done'), status: 'passed' as const };
    const pending = makeTestCase('tc-pending');
    await testCaseDB.put(passed);
    await testCaseDB.put(pending);

    const results = await executeAllTests(mockAIClient as never);

    expect(results).toHaveLength(1);
    expect(results[0].testCaseId).toBe('tc-pending');
  });

  it('given rerunAll=true when executeAllTests then re-runs all tests regardless of status', async () => {
    const passed = { ...makeTestCase('tc-done'), status: 'passed' as const };
    await testCaseDB.put(passed);

    const results = await executeAllTests(mockAIClient as never, { rerunAll: true });

    expect(results).toHaveLength(1);
  });
});

describe('executeAllTests — run controls (budget, ordering, ceiling)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await testCaseDB.clear();
    await testResultDB.clear();
    configureBudget({ limitUsd: null }); // reset between tests
    mockAIClient.chat.mockResolvedValue(validAIPlanResponse);
    vi.mocked(getPageSnapshot).mockResolvedValue({
      url: 'https://app.example.com', title: 'App', elements: [], domCompressed: '<div/>', capturedAt: new Date().toISOString(),
    });
    vi.mocked(runStep).mockImplementation(async (step) => makePassedStep(step));
    vi.mocked(recoverSessionIfExpired).mockResolvedValue(false);
  });

  it('given a BudgetExceededError mid-run when executing then the run stops and skips remaining tests', async () => {
    await testCaseDB.put(makeTestCase('tc-a'));
    await testCaseDB.put(makeTestCase('tc-b'));

    // First test's first step keeps failing → healing is invoked → budget throws.
    vi.mocked(runStep).mockImplementation(async (step) =>
      step.selector === '#login-btn' ? makeFailedStep(step) : makePassedStep(step)
    );
    vi.mocked(healStep).mockRejectedValue(new BudgetExceededError(1, 1.5, 10));

    const results = await executeAllTests(mockAIClient as never, { concurrency: 1 });

    // Run aborted before completing both tests.
    expect(results.length).toBeLessThan(2);
    expect(healStep).toHaveBeenCalled();
  });

  it('given concurrent execution when complete then results preserve input order', async () => {
    await testCaseDB.put(makeTestCase('tc-1'));
    await testCaseDB.put(makeTestCase('tc-2'));
    await testCaseDB.put(makeTestCase('tc-3'));

    const results = await executeAllTests(mockAIClient as never, { concurrency: 2 });

    expect(results.map((r) => r.testCaseId)).toEqual(['tc-1', 'tc-2', 'tc-3']);
  });

  it('given a tiny per-test ceiling when executing then the test is aborted and marked failed', async () => {
    await testCaseDB.put(makeTestCase('tc-ceil'));

    const results = await executeAllTests(mockAIClient as never, { maxTestDurationMs: 5 });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('failed');
    expect(results[0].errorMessage).toMatch(/aborted/i);
  }, 15000);
});
