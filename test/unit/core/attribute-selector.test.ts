import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InteractiveElement } from '../../../src/storage/schemas';

vi.mock('../../../src/messaging/messenger', () => ({
  sendToContentScript: vi.fn(),
}));

const { buildAttributeSelectors } = await import('../../../src/core/healing/attribute-selector');
const { sendToContentScript } = await import('../../../src/messaging/messenger');

const el = (overrides: Partial<InteractiveElement>): InteractiveElement => ({
  selector: 'button',
  tag: 'button',
  visible: true,
  position: { x: 0, y: 0, width: 1, height: 1 },
  ...overrides,
});

const reply = (elements: InteractiveElement[]) =>
  vi.mocked(sendToContentScript).mockResolvedValue({ payload: elements } as never);

beforeEach(() => vi.clearAllMocks());

describe('buildAttributeSelectors', () => {
  it('given content script throws when building then returns empty', async () => {
    vi.mocked(sendToContentScript).mockRejectedValue(new Error('boom'));
    expect(await buildAttributeSelectors('submit', 1)).toEqual([]);
  });

  it('given empty elements when building then returns empty', async () => {
    reply([]);
    expect(await buildAttributeSelectors('submit', 1)).toEqual([]);
  });

  it('given keyword matches text when building then derives selectors with testid first', async () => {
    reply([
      el({ selector: '.s', tag: 'button', text: 'Submit form', testId: 'submit-btn' }),
    ]);
    const result = await buildAttributeSelectors('click submit', 1);
    expect(result).toContain('[data-testid="submit-btn"]');
    expect(result).toContain('button[data-testid="submit-btn"]');
  });

  it('given keyword does not match any element when building then returns empty', async () => {
    reply([el({ tag: 'button', text: 'Cancel' })]);
    expect(await buildAttributeSelectors('submit form', 1)).toEqual([]);
  });

  it('given element with aria-label when building then includes aria selector', async () => {
    reply([el({ tag: 'button', text: '', ariaLabel: 'Save changes' })]);
    const result = await buildAttributeSelectors('save', 1);
    expect(result).toContain('[aria-label="Save changes"]');
  });

  it('given element with name attribute when building then includes name selector', async () => {
    reply([el({ tag: 'input', text: 'email field', name: 'email' })]);
    const result = await buildAttributeSelectors('email', 1);
    expect(result).toContain('input[name="email"]');
  });

  it('given element with classes when building then includes class selector', async () => {
    reply([el({ tag: 'button', text: 'submit', classes: ['btn', 'primary'] })]);
    const result = await buildAttributeSelectors('submit', 1);
    expect(result.some((s) => s.includes('.btn'))).toBe(true);
  });

  it('given duplicate selectors across elements when building then dedupes', async () => {
    reply([
      el({ selector: '.same', tag: 'button', text: 'submit' }),
      el({ selector: '.same', tag: 'button', text: 'submit' }),
    ]);
    const result = await buildAttributeSelectors('submit', 1);
    const occurrences = result.filter((s) => s === '.same').length;
    expect(occurrences).toBe(1);
  });

  it('given many candidates when building then caps to 5', async () => {
    reply([
      el({ selector: '.a', text: 'submit', testId: 't1', ariaLabel: 'a', name: 'n1', role: 'button', classes: ['c1', 'c2'] }),
    ]);
    const result = await buildAttributeSelectors('submit', 1);
    expect(result.length).toBeLessThanOrEqual(5);
  });
});
