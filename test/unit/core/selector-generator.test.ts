import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/messaging/messenger', () => ({
  sendToContentScript: vi.fn(),
}));

vi.mock('../../../src/core/ai/prompt-templates', () => ({
  PROMPTS: {
    selectorHealing: {
      system: 'sys',
      user: (a: string, b: string, c: string) => `u:${a}:${b}:${c}`,
    },
  },
}));

const { generateAlternativeSelectors } = await import('../../../src/core/healing/selector-generator');
const { sendToContentScript } = await import('../../../src/messaging/messenger');

const ai = { chat: vi.fn(), embed: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sendToContentScript).mockResolvedValue({ payload: { domCompressed: '<dom/>' } } as never);
});

describe('generateAlternativeSelectors', () => {
  it('given AI returns valid JSON when generating then returns alternatives', async () => {
    ai.chat.mockResolvedValue(JSON.stringify({ alternatives: ['button.a', '#b'] }));
    const result = await generateAlternativeSelectors('#x', 'click submit', 1, ai as never);
    expect(result).toEqual(['button.a', '#b']);
  });

  it('given AI returns markdown-fenced JSON when generating then strips fences', async () => {
    ai.chat.mockResolvedValue('```json\n{"alternatives":["button.a"]}\n```');
    const result = await generateAlternativeSelectors('#x', 'd', 1, ai as never);
    expect(result).toEqual(['button.a']);
  });

  it('given AI throws when generating then returns empty', async () => {
    ai.chat.mockRejectedValue(new Error('rate limit'));
    expect(await generateAlternativeSelectors('#x', 'd', 1, ai as never)).toEqual([]);
  });

  it('given AI returns malformed JSON when generating then returns empty', async () => {
    ai.chat.mockResolvedValue('not json');
    expect(await generateAlternativeSelectors('#x', 'd', 1, ai as never)).toEqual([]);
  });

  it('given alternatives array missing when generating then returns empty', async () => {
    ai.chat.mockResolvedValue(JSON.stringify({ other: ['x'] }));
    expect(await generateAlternativeSelectors('#x', 'd', 1, ai as never)).toEqual([]);
  });

  it('given empty strings in alternatives when generating then filters them out', async () => {
    ai.chat.mockResolvedValue(JSON.stringify({ alternatives: ['', 'button.a', ''] }));
    const result = await generateAlternativeSelectors('#x', 'd', 1, ai as never);
    expect(result).toEqual(['button.a']);
  });

  it('given DOM context fetch throws when generating then proceeds with empty context', async () => {
    vi.mocked(sendToContentScript).mockRejectedValue(new Error('no dom'));
    ai.chat.mockResolvedValue(JSON.stringify({ alternatives: ['x'] }));
    const result = await generateAlternativeSelectors('#x', 'd', 1, ai as never);
    expect(result).toEqual(['x']);
  });

  it('given AI is called when generating then uses jsonMode and low temperature', async () => {
    ai.chat.mockResolvedValue(JSON.stringify({ alternatives: [] }));
    await generateAlternativeSelectors('#x', 'd', 1, ai as never);
    expect(ai.chat).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ temperature: 0.2, jsonMode: true }),
    );
  });
});
