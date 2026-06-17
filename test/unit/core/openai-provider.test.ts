import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAIProvider } from '../../../src/core/ai/openai-provider';

/** Build a fake fetch Response for the chat endpoint. */
function chatResponse(content: string | null, finish_reason: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => 'error body',
    json: async () => ({
      choices: [{ message: { content }, finish_reason }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }),
  };
}

function tokenBudgetOf(call: [string, RequestInit]): number {
  const body = JSON.parse(call[1].body as string);
  return body.max_completion_tokens ?? body.max_tokens;
}

describe('OpenAIProvider.chat — empty-on-truncation auto-retry', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('given empty content with finish_reason=length when first call then retries with a larger token budget', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(chatResponse(null, 'length'))           // truncated, empty
      .mockResolvedValueOnce(chatResponse('{"steps":[]}', 'stop')); // succeeds on retry
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAIProvider('sk-test', 'gpt-4o', 'text-embedding-3-small');
    const out = await provider.chat([{ role: 'user', content: 'expand' }], { maxTokens: 4096, jsonMode: true });

    expect(out).toBe('{"steps":[]}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(tokenBudgetOf(calls[0])).toBe(4096);
    expect(tokenBudgetOf(calls[1])).toBeGreaterThan(4096); // bumped
  });

  it('given empty content persists across the retry then throws an actionable error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatResponse(null, 'length'));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAIProvider('sk-test', 'gpt-4o', 'text-embedding-3-small');

    await expect(
      provider.chat([{ role: 'user', content: 'expand' }], { maxTokens: 4096 })
    ).rejects.toThrow(/empty content \(finish_reason=length\)/);
    expect(fetchMock).toHaveBeenCalledTimes(2); // original + one retry, then give up
  });

  it('given a normal completion then returns content without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(chatResponse('hello', 'stop'));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAIProvider('sk-test', 'gpt-4o', 'text-embedding-3-small');
    const out = await provider.chat([{ role: 'user', content: 'hi' }]);

    expect(out).toBe('hello');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('given a reasoning model with a tiny maxTokens then floors the budget and sends reasoning_effort', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(chatResponse('{"ok":true}', 'stop'));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAIProvider('sk-test', 'gpt-5', 'text-embedding-3-small');
    const out = await provider.chat([{ role: 'user', content: 'hi' }], { maxTokens: 200 });

    expect(out).toBe('{"ok":true}');
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    // Tiny 200-token request is floored so reasoning tokens don't starve output.
    expect(body.max_completion_tokens).toBeGreaterThanOrEqual(16_000);
    expect(body.reasoning_effort).toBe('low');
    // Reasoning models reject custom temperature — must be omitted.
    expect(body.temperature).toBeUndefined();
  });

  it('given a reasoning model that rejects reasoning_effort then strips it and retries', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => "Unsupported parameter: 'reasoning_effort'", json: async () => ({}) })
      .mockResolvedValueOnce(chatResponse('done', 'stop'));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAIProvider('sk-test', 'o3-mini', 'text-embedding-3-small');
    const out = await provider.chat([{ role: 'user', content: 'hi' }]);

    expect(out).toBe('done');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
    expect(retryBody.reasoning_effort).toBeUndefined();
  });
});
