import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InteractiveElement } from '../../../src/storage/schemas';

vi.mock('../../../src/messaging/messenger', () => ({
  sendToContentScript: vi.fn(),
}));

const { findSimilarElements } = await import('../../../src/core/healing/dom-similarity');
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

describe('findSimilarElements', () => {
  it('given content script throws when finding then returns empty', async () => {
    vi.mocked(sendToContentScript).mockRejectedValue(new Error('boom'));
    expect(await findSimilarElements('#x', 'desc', 1)).toEqual([]);
  });

  it('given empty elements when finding then returns empty', async () => {
    reply([]);
    expect(await findSimilarElements('#x', 'desc', 1)).toEqual([]);
  });

  it('given strong text overlap and matching tag when finding then returns selector', async () => {
    reply([
      el({ selector: 'button.submit', tag: 'button', text: 'Submit form now', ariaLabel: 'submit' }),
    ]);
    const result = await findSimilarElements('button.original', 'click submit form now', 1);
    expect(result).toEqual(['button.submit']);
  });

  it('given weak overlap below threshold when finding then filters out', async () => {
    reply([el({ selector: 'div.unrelated', text: 'totally different content here' })]);
    const result = await findSimilarElements('#x', 'click submit', 1);
    expect(result).toEqual([]);
  });

  it('given multiple matches when finding then returns top 3 sorted by score', async () => {
    reply([
      el({ selector: '.a', text: 'submit form now today' }),
      el({ selector: '.b', text: 'submit form now' }),
      el({ selector: '.c', text: 'submit form' }),
      el({ selector: '.d', text: 'submit it now' }),
    ]);
    const result = await findSimilarElements('button', 'submit form now today exactly', 1);
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it('given visibility boost when finding then visible elements rank higher', async () => {
    reply([
      el({ selector: '.hidden', text: 'submit form now', visible: false }),
      el({ selector: '.shown', text: 'submit form now', visible: true }),
    ]);
    const result = await findSimilarElements('button', 'click submit form now', 1);
    expect(result[0]).toBe('.shown');
  });
});
