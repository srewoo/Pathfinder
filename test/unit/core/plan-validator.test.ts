import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExecutionStep, InteractiveElement, PageSnapshot } from '../../../src/storage/schemas';

vi.mock('../../../src/core/explorer/page-scanner', () => ({
  getPageSnapshot: vi.fn(),
}));

vi.mock('../../../src/messaging/messenger', () => ({
  sendToContentScript: vi.fn(),
}));

const { validateAndRepairPlan } = await import('../../../src/core/planner/plan-validator');
const { getPageSnapshot } = await import('../../../src/core/explorer/page-scanner');
const { sendToContentScript } = await import('../../../src/messaging/messenger');

function el(overrides: Partial<InteractiveElement>): InteractiveElement {
  return {
    selector: 'button',
    tag: 'button',
    visible: true,
    position: { x: 0, y: 0, width: 10, height: 10 },
    ...overrides,
  };
}

function snapshot(elements: InteractiveElement[]): PageSnapshot {
  return {
    url: 'https://x.com/',
    title: 't',
    elements,
    domCompressed: '',
    capturedAt: new Date().toISOString(),
  };
}

const step = (overrides: Partial<ExecutionStep>): ExecutionStep => ({
  order: 1,
  action: 'click',
  description: 'desc',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  // Default: live validation says selector does NOT match (false), forcing snapshot fallback
  vi.mocked(sendToContentScript).mockRejectedValue(new Error('no live validate'));
});

describe('validateAndRepairPlan', () => {
  it('given step with skip-action when validating then passes through unchanged', async () => {
    vi.mocked(getPageSnapshot).mockResolvedValue(snapshot([]));
    const s = step({ action: 'navigate', selector: undefined });
    const result = await validateAndRepairPlan(1, [s]);
    expect(result.valid).toBe(true);
    expect(result.repairedSteps).toEqual([s]);
  });

  it('given step without selector when validating then passes through', async () => {
    vi.mocked(getPageSnapshot).mockResolvedValue(snapshot([]));
    const s = step({ action: 'click', selector: undefined });
    const result = await validateAndRepairPlan(1, [s]);
    expect(result.repairedSteps[0]).toEqual(s);
    expect(result.issues).toHaveLength(0);
  });

  it('given live validation returns true when validating then keeps original selector', async () => {
    vi.mocked(getPageSnapshot).mockResolvedValue(snapshot([]));
    vi.mocked(sendToContentScript).mockResolvedValue({ payload: true } as never);
    const s = step({ selector: '#submit' });
    const result = await validateAndRepairPlan(1, [s]);
    expect(result.repairedSteps[0].selector).toBe('#submit');
    expect(result.issues).toHaveLength(0);
    expect(result.valid).toBe(true);
  });

  it('given live validation rejects but snapshot has matching id when validating then keeps selector', async () => {
    vi.mocked(getPageSnapshot).mockResolvedValue(
      snapshot([el({ selector: 'button#submit' })])
    );
    const s = step({ selector: '#submit' });
    const result = await validateAndRepairPlan(1, [s]);
    expect(result.repairedSteps[0].selector).toBe('#submit');
    expect(result.issues).toHaveLength(0);
  });

  it('given empty snapshot when validating broken selector then assumes valid', async () => {
    vi.mocked(getPageSnapshot).mockResolvedValue(snapshot([]));
    const s = step({ selector: '#anything' });
    const result = await validateAndRepairPlan(1, [s]);
    expect(result.issues).toHaveLength(0);
  });

  it('given quoted hint and aria match when repairing then prepends aria selector', async () => {
    vi.mocked(getPageSnapshot).mockResolvedValue(
      snapshot([el({ selector: '.x', ariaLabel: 'Submit form', tag: 'button' })])
    );
    const s = step({ selector: '#missing', description: 'Click the "Submit" button' });
    const result = await validateAndRepairPlan(1, [s]);
    expect(result.repairedSteps[0].selector).toContain('[aria-label="Submit form"]');
    expect(result.repairedSteps[0].selector).toContain('#missing');
    expect(result.issues[0].fixedSelector).toBe('[aria-label="Submit form"]');
  });

  it('given testId match for hint when repairing then uses data-testid selector', async () => {
    vi.mocked(getPageSnapshot).mockResolvedValue(
      snapshot([el({ selector: '.x', testId: 'login-button', tag: 'button', text: 'Login' })])
    );
    const s = step({ selector: '#missing', description: 'Click "Login" button' });
    const result = await validateAndRepairPlan(1, [s]);
    expect(result.repairedSteps[0].selector).toContain('[data-testid="login-button"]');
  });

  it('given name match when repairing then uses [name=..] selector', async () => {
    vi.mocked(getPageSnapshot).mockResolvedValue(
      snapshot([el({ selector: 'input', name: 'email', tag: 'input' })])
    );
    const s = step({ selector: '#missing', description: 'Fill the "email" field' });
    const result = await validateAndRepairPlan(1, [s]);
    expect(result.repairedSteps[0].selector).toContain('[name="email"]');
  });

  it('given no hints match when repairing then leaves selector and reports unrepaired', async () => {
    vi.mocked(getPageSnapshot).mockResolvedValue(
      snapshot([el({ selector: 'div', text: 'irrelevant' })])
    );
    const s = step({ selector: '#nope', description: 'click somewhere' });
    const result = await validateAndRepairPlan(1, [s]);
    expect(result.valid).toBe(false);
    expect(result.issues[0].fixedSelector).toBeUndefined();
  });

  it('given comma-separated selector with one valid alternative when validating then accepts', async () => {
    vi.mocked(getPageSnapshot).mockResolvedValue(
      snapshot([el({ selector: 'button.submit-btn' })])
    );
    const s = step({ selector: '#missing, button.submit-btn' });
    const result = await validateAndRepairPlan(1, [s]);
    expect(result.issues).toHaveLength(0);
  });

  it('given page snapshot fetch throws when validating then falls back to empty elements', async () => {
    vi.mocked(getPageSnapshot).mockRejectedValue(new Error('boom'));
    const s = step({ selector: '#anything' });
    const result = await validateAndRepairPlan(1, [s]);
    // Empty elements => selectorMatchesElement returns true => no issue
    expect(result.issues).toHaveLength(0);
  });
});
