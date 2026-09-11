import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  healStep,
  registerHealedSelector,
  getHealedSelector,
  clearHealingRegistry,
} from '../../../src/core/healing/self-healer';
import type { ExecutionStep } from '../../../src/storage/schemas';

vi.mock('../../../src/core/healing/dom-similarity', () => ({
  findSimilarElements: vi.fn(),
}));

vi.mock('../../../src/core/healing/selector-generator', () => ({
  generateAlternativeSelectors: vi.fn(),
  // Strategy 4 (vision) reads the same DOM context the AI strategy uses.
  getDOMContext: vi.fn(async () => '<button aria-label="Share"></button>'),
}));

// Strategy 4: vision — mocked so no image is ever sent from a unit test.
vi.mock('../../../src/core/healing/visual-locator', () => ({
  proposeSelectorFromScreenshot: vi.fn(),
}));

// Strategy 2: attribute-based selectors — mock so tests are deterministic
vi.mock('../../../src/core/healing/attribute-selector', () => ({
  buildAttributeSelectors: vi.fn(),
}));

vi.mock('../../../src/core/executor/action-runner', () => ({
  runStep: vi.fn(),
  navigateTab: vi.fn(),
}));

const { findSimilarElements } = await import('../../../src/core/healing/dom-similarity');
const { generateAlternativeSelectors } = await import('../../../src/core/healing/selector-generator');
const { buildAttributeSelectors } = await import('../../../src/core/healing/attribute-selector');
const { runStep } = await import('../../../src/core/executor/action-runner');
const { proposeSelectorFromScreenshot } = await import(
  '../../../src/core/healing/visual-locator'
);

const mockAIClient = {
  chat: vi.fn(),
  embed: vi.fn(),
};

const baseStep: ExecutionStep = {
  order: 1,
  action: 'click',
  selector: '#missing-button',
  description: 'Click the Submit button',
};

describe('healStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearHealingRegistry();
    vi.mocked(buildAttributeSelectors).mockResolvedValue([]);
  });

  it('given similarity match when healing then returns healed step with similarity method', async () => {
    vi.mocked(findSimilarElements).mockResolvedValue(['button.submit-btn']);
    vi.mocked(runStep).mockResolvedValue({ step: baseStep, status: 'passed', duration: 100 });

    const result = await healStep(baseStep, 'Element not found', 1, mockAIClient as never);

    expect(result.success).toBe(true);
    expect(result.attempt.method).toBe('similarity');
    expect(result.attempt.healedSelector).toBe('button.submit-btn');
  });

  it('given no similarity match but AI match when healing then returns AI healed step', async () => {
    vi.mocked(findSimilarElements).mockResolvedValue([]);
    vi.mocked(generateAlternativeSelectors).mockResolvedValue(['[type="submit"]']);
    vi.mocked(runStep).mockResolvedValue({ step: baseStep, status: 'passed', duration: 100 });

    const result = await healStep(baseStep, 'Element not found', 1, mockAIClient as never);

    expect(result.success).toBe(true);
    expect(result.attempt.method).toBe('ai');
  });

  it('given no alternative selectors found when healing then returns failure', async () => {
    vi.mocked(findSimilarElements).mockResolvedValue([]);
    vi.mocked(generateAlternativeSelectors).mockResolvedValue([]);

    const result = await healStep(baseStep, 'Element not found', 1, mockAIClient as never);

    expect(result.success).toBe(false);
    expect(result.healedStep).toBeUndefined();
  });

  it('given similarity selectors that also fail when healing then falls through to AI', async () => {
    vi.mocked(findSimilarElements).mockResolvedValue(['button.wrong-btn']);
    vi.mocked(generateAlternativeSelectors).mockResolvedValue(['button[data-id="submit"]']);
    vi.mocked(runStep)
      .mockResolvedValueOnce({ step: baseStep, status: 'failed', duration: 50, error: 'not found' })
      .mockResolvedValueOnce({ step: baseStep, status: 'passed', duration: 100 });

    const result = await healStep(baseStep, 'Element not found', 1, mockAIClient as never);

    expect(result.success).toBe(true);
    expect(result.attempt.method).toBe('ai');
  });

  it('given step without selector when healing then returns failure immediately', async () => {
    const stepWithoutSelector: ExecutionStep = { ...baseStep, selector: undefined };
    vi.mocked(findSimilarElements).mockResolvedValue([]);
    vi.mocked(generateAlternativeSelectors).mockResolvedValue([]);

    const result = await healStep(stepWithoutSelector, 'no element', 1, mockAIClient as never);

    expect(result.success).toBe(false);
  });

  it('given healing attempt when recording then includes originalSelector in attempt', async () => {
    vi.mocked(findSimilarElements).mockResolvedValue([]);
    vi.mocked(generateAlternativeSelectors).mockResolvedValue([]);

    const result = await healStep(baseStep, 'error', 1, mockAIClient as never);

    expect(result.attempt.originalSelector).toBe('#missing-button');
    expect(result.attempt.stepOrder).toBe(1);
  });

  it('given attribute strategy yields a working selector when healing then returns alternative method', async () => {
    vi.mocked(findSimilarElements).mockResolvedValue([]);
    vi.mocked(buildAttributeSelectors).mockResolvedValue(['[data-testid="submit"]']);
    vi.mocked(runStep).mockResolvedValue({ step: baseStep, status: 'passed', duration: 80 });

    const result = await healStep(baseStep, 'no element', 1, mockAIClient as never);

    expect(result.success).toBe(true);
    expect(result.attempt.method).toBe('alternative');
    expect(result.attempt.healedSelector).toBe('[data-testid="submit"]');
  });

  it('given registry has prior heal when healing then short-circuits to cached selector', async () => {
    registerHealedSelector('#missing-button', '[data-testid="cached"]');
    vi.mocked(runStep).mockResolvedValue({ step: baseStep, status: 'passed', duration: 5 });

    const result = await healStep(baseStep, 'err', 1, mockAIClient as never);

    expect(result.success).toBe(true);
    expect(result.attempt.healedSelector).toBe('[data-testid="cached"]');
    // Should not consult similarity / attribute / AI strategies
    expect(findSimilarElements).not.toHaveBeenCalled();
    expect(buildAttributeSelectors).not.toHaveBeenCalled();
    expect(generateAlternativeSelectors).not.toHaveBeenCalled();
  });

  it('given stale registry entry when healing then evicts and falls through to live strategies', async () => {
    registerHealedSelector('#missing-button', '[data-testid="stale"]');
    vi.mocked(findSimilarElements).mockResolvedValue(['button.fresh']);
    vi.mocked(runStep)
      .mockResolvedValueOnce({ step: baseStep, status: 'failed', duration: 5, error: 'gone' })
      .mockResolvedValueOnce({ step: baseStep, status: 'passed', duration: 5 });

    const result = await healStep(baseStep, 'err', 1, mockAIClient as never);

    expect(result.success).toBe(true);
    expect(result.attempt.healedSelector).toBe('button.fresh');
    expect(getHealedSelector('#missing-button')).toBeUndefined();
  });

  it('given clearHealingRegistry is called when registered then removes entry', () => {
    registerHealedSelector('#a', '#b');
    expect(getHealedSelector('#a')).toBe('#b');
    clearHealingRegistry();
    expect(getHealedSelector('#a')).toBeUndefined();
  });

  it('given a mutating action when validating a candidate then it PROBES (assert visible), not the real action', async () => {
    // baseStep is a click (side-effecting). Healing must validate the candidate
    // selector with a locate-only probe so it can't fire the click repeatedly
    // (double-submit). The executor performs the real click once, after healing.
    vi.mocked(findSimilarElements).mockResolvedValue(['button.candidate']);
    vi.mocked(runStep).mockResolvedValue({ step: baseStep, status: 'passed', duration: 10 });

    const result = await healStep(baseStep, 'not found', 1, mockAIClient as never);

    expect(result.success).toBe(true);
    // The healed step still carries the real action for the executor to run once.
    expect(result.healedStep?.action).toBe('click');
    expect(result.healedStep?.selector).toBe('button.candidate');
    // But every validation call the healer made was a non-mutating probe.
    const runnerCalls = vi.mocked(runStep).mock.calls;
    expect(runnerCalls.length).toBeGreaterThan(0);
    for (const [probeStep] of runnerCalls) {
      expect(probeStep.action).toBe('assert');
      expect(probeStep.assertType).toBe('visible');
      expect(probeStep.selector).toBe('button.candidate');
    }
  });

  it('given a non-mutating action when validating then it runs the real step (no probe rewrite)', async () => {
    const assertStep: ExecutionStep = { order: 1, action: 'assert', assertType: 'visible', selector: '#gone', description: 'verify banner' };
    vi.mocked(findSimilarElements).mockResolvedValue(['.banner']);
    vi.mocked(runStep).mockResolvedValue({ step: assertStep, status: 'passed', duration: 10 });

    const result = await healStep(assertStep, 'not found', 1, mockAIClient as never);

    expect(result.success).toBe(true);
    // A read-only assert is safe to execute directly during validation.
    expect(vi.mocked(runStep).mock.calls[0][0].selector).toBe('.banner');
  });

  it('given all strategies exhausted when healing then surfaces ai method failure', async () => {
    vi.mocked(findSimilarElements).mockResolvedValue(['s1']);
    vi.mocked(buildAttributeSelectors).mockResolvedValue(['s2']);
    vi.mocked(generateAlternativeSelectors).mockResolvedValue(['s3']);
    vi.mocked(runStep).mockResolvedValue({ step: baseStep, status: 'failed', duration: 1, error: 'x' });

    const result = await healStep(baseStep, 'err', 1, mockAIClient as never);

    expect(result.success).toBe(false);
    expect(result.attempt.method).toBe('ai');
    expect(result.attempt.error).toBe('err');
  });
});


describe('healStep vision tier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(findSimilarElements).mockResolvedValue([]);
    vi.mocked(buildAttributeSelectors).mockResolvedValue([]);
    vi.mocked(generateAlternativeSelectors).mockResolvedValue([]);
    vi.mocked(proposeSelectorFromScreenshot).mockResolvedValue([]);
    clearHealingRegistry();
  });

  it('given_all_dom_strategies_fail_and_a_screenshot_exists_then_healing_uses_the_visual_tier', async () => {
    vi.mocked(proposeSelectorFromScreenshot).mockResolvedValue(["[aria-label='Share']"]);
    // Accept only the selector the vision model proposes, so no earlier tier
    // can succeed by accident.
    vi.mocked(runStep).mockImplementation(async (step) => ({
      step,
      status: step.selector === "[aria-label='Share']" ? 'passed' : 'failed',
      duration: 1,
    }));

    const result = await healStep(
      baseStep,
      'element not found',
      1,
      mockAIClient as never,
      runStep,
      { screenshot: 'BASE64PNG' }
    );

    expect(result.success).toBe(true);
    expect(result.attempt.method).toBe('visual');
    expect(result.healedStep?.selector).toBe("[aria-label='Share']");
  });

  // The vision call is the most expensive tier; it must not run when a cheaper
  // one already worked.
  it('given_a_dom_strategy_succeeds_then_the_vision_tier_is_never_called', async () => {
    vi.mocked(findSimilarElements).mockResolvedValue(['#found-by-similarity']);
    vi.mocked(runStep).mockImplementation(async (step) => ({
      step,
      status: step.selector === '#found-by-similarity' ? 'passed' : 'failed',
      duration: 1,
    }));

    const result = await healStep(baseStep, 'boom', 1, mockAIClient as never, runStep, {
      screenshot: 'BASE64PNG',
    });

    expect(result.success).toBe(true);
    expect(result.attempt.method).toBe('similarity');
    expect(proposeSelectorFromScreenshot).not.toHaveBeenCalled();
  });

  it('given_no_screenshot_then_the_vision_tier_is_skipped_entirely', async () => {
    vi.mocked(runStep).mockResolvedValue({ step: baseStep, status: 'failed', duration: 1 });

    const result = await healStep(baseStep, 'boom', 1, mockAIClient as never, runStep);

    expect(result.success).toBe(false);
    expect(proposeSelectorFromScreenshot).not.toHaveBeenCalled();
  });

  it('given_the_vision_tier_proposes_nothing_then_healing_fails_cleanly', async () => {
    vi.mocked(runStep).mockResolvedValue({ step: baseStep, status: 'failed', duration: 1 });

    const result = await healStep(baseStep, 'boom', 1, mockAIClient as never, runStep, {
      screenshot: 'BASE64PNG',
    });

    expect(result.success).toBe(false);
    expect(proposeSelectorFromScreenshot).toHaveBeenCalledTimes(1);
  });
});
