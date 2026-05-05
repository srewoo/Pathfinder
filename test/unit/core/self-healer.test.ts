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
