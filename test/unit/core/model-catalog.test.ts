import { describe, it, expect, vi } from 'vitest';
import {
  listModels,
  chatModels,
  embeddingModels,
  type ModelOption,
} from '../../../src/core/ai/model-catalog';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function openAIPayload(ids: string[]) {
  return { data: ids.map((id) => ({ id, created: 1 })) };
}

describe('listModels — request shape', () => {
  it('given_openai_then_it_calls_the_models_endpoint_with_a_bearer_token', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(openAIPayload(['gpt-5.1'])));
    await listModels('openai', 'sk-test', fetchImpl as unknown as typeof fetch);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/models');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
  });

  it('given_anthropic_then_it_sends_the_version_and_browser_access_headers', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ id: 'claude-sonnet-4-6' }] }));
    await listModels('anthropic', 'sk-ant-test', fetchImpl as unknown as typeof fetch);

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    // Without this header Anthropic refuses any non-server origin.
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true');
  });

  // The key must not travel in a URL, where it lands in error strings and logs.
  it('given_google_then_the_key_is_a_header_and_never_in_the_url', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ models: [{ name: 'models/gemini-3-pro', supportedGenerationMethods: ['generateContent'] }] })
    );
    await listModels('google', 'AIzaSECRET', fetchImpl as unknown as typeof fetch);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain('AIzaSECRET');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('AIzaSECRET');
  });

  it('given_a_key_with_surrounding_whitespace_then_it_is_trimmed_before_sending', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(openAIPayload(['gpt-5.1'])));
    await listModels('openai', '  sk-test  ', fetchImpl as unknown as typeof fetch);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
  });

  it('given_an_empty_key_then_it_fails_without_a_request', async () => {
    const fetchImpl = vi.fn();
    const result = await listModels('openai', '   ', fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ ok: false, error: 'Enter an API key first.' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('listModels — OpenAI parsing', () => {
  it('given_a_catalogue_then_chat_models_are_returned', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(openAIPayload(['gpt-5.1', 'gpt-4o'])));
    const result = await listModels('openai', 'k', fetchImpl as unknown as typeof fetch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.models.map((m) => m.id).sort()).toEqual(['gpt-4o', 'gpt-5.1']);
    expect(result.models.every((m) => m.kind === 'chat')).toBe(true);
  });

  it('given_an_embedding_model_then_it_is_classified_as_embedding_not_chat', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(openAIPayload(['gpt-5.1', 'text-embedding-3-small']))
    );
    const result = await listModels('openai', 'k', fetchImpl as unknown as typeof fetch);
    if (!result.ok) throw new Error('expected ok');
    expect(embeddingModels(result.models).map((m) => m.id)).toEqual(['text-embedding-3-small']);
    expect(chatModels(result.models).map((m) => m.id)).toEqual(['gpt-5.1']);
  });

  // Offering these would let a user select a model guaranteed to 400 at run time.
  it.each([
    'whisper-1',
    'tts-1',
    'dall-e-3',
    'omni-moderation-latest',
    'gpt-4o-audio-preview',
    'gpt-4o-realtime-preview',
    'davinci-002',
    'babbage-002',
    'gpt-image-1',
  ])('given_the_non_chat_model_%s_then_it_is_excluded', async (id) => {
    const fetchImpl = vi.fn(async () => jsonResponse(openAIPayload(['gpt-5.1', id])));
    const result = await listModels('openai', 'k', fetchImpl as unknown as typeof fetch);
    if (!result.ok) throw new Error('expected ok');
    expect(result.models.map((m) => m.id)).toEqual(['gpt-5.1']);
  });

  it('given_models_with_created_dates_then_the_newest_is_first', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [
          { id: 'gpt-4o', created: 100 },
          { id: 'gpt-5.1', created: 900 },
          { id: 'gpt-4.1', created: 500 },
        ],
      })
    );
    const result = await listModels('openai', 'k', fetchImpl as unknown as typeof fetch);
    if (!result.ok) throw new Error('expected ok');
    expect(result.models.map((m) => m.id)).toEqual(['gpt-5.1', 'gpt-4.1', 'gpt-4o']);
  });

  it('given_an_entry_with_no_id_then_it_is_skipped_rather_than_listed_blank', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ created: 1 }, { id: 'gpt-5.1' }] }));
    const result = await listModels('openai', 'k', fetchImpl as unknown as typeof fetch);
    if (!result.ok) throw new Error('expected ok');
    expect(result.models.map((m) => m.id)).toEqual(['gpt-5.1']);
  });
});

describe('listModels — Anthropic parsing', () => {
  it('given_a_catalogue_then_the_display_name_becomes_the_label', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [
          { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', created_at: '2026-02-01T00:00:00Z' },
        ],
      })
    );
    const result = await listModels('anthropic', 'k', fetchImpl as unknown as typeof fetch);
    if (!result.ok) throw new Error('expected ok');
    expect(result.models[0]).toMatchObject({
      id: 'claude-sonnet-4-6',
      label: 'Claude Sonnet 4.6',
      kind: 'chat',
    });
  });

  it('given_no_display_name_then_the_id_is_the_label', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ id: 'claude-opus-4-7' }] }));
    const result = await listModels('anthropic', 'k', fetchImpl as unknown as typeof fetch);
    if (!result.ok) throw new Error('expected ok');
    expect(result.models[0].label).toBe('claude-opus-4-7');
  });

  it('given_created_at_timestamps_then_the_newest_model_is_first', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [
          { id: 'old', created_at: '2024-01-01T00:00:00Z' },
          { id: 'new', created_at: '2026-01-01T00:00:00Z' },
        ],
      })
    );
    const result = await listModels('anthropic', 'k', fetchImpl as unknown as typeof fetch);
    if (!result.ok) throw new Error('expected ok');
    expect(result.models.map((m) => m.id)).toEqual(['new', 'old']);
  });

  // Anthropic has no embedding API, so nothing it lists may be offered as one.
  it('given_an_anthropic_catalogue_then_no_model_is_marked_as_an_embedding_model', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ id: 'claude-sonnet-4-6' }] }));
    const result = await listModels('anthropic', 'k', fetchImpl as unknown as typeof fetch);
    if (!result.ok) throw new Error('expected ok');
    expect(embeddingModels(result.models)).toEqual([]);
  });
});

describe('listModels — Google parsing', () => {
  it('given_the_models_prefix_then_it_is_stripped_from_the_id', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        models: [
          {
            name: 'models/gemini-3-pro',
            displayName: 'Gemini 3 Pro',
            supportedGenerationMethods: ['generateContent'],
          },
        ],
      })
    );
    const result = await listModels('google', 'k', fetchImpl as unknown as typeof fetch);
    if (!result.ok) throw new Error('expected ok');
    expect(result.models[0]).toMatchObject({ id: 'gemini-3-pro', label: 'Gemini 3 Pro', kind: 'chat' });
  });

  // The declared methods are authoritative; guessing from the name is how an
  // embedding model ends up selected for chat.
  it('given_supported_methods_then_they_decide_the_kind_not_the_name', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        models: [
          { name: 'models/gemini-3-pro', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
        ],
      })
    );
    const result = await listModels('google', 'k', fetchImpl as unknown as typeof fetch);
    if (!result.ok) throw new Error('expected ok');
    expect(chatModels(result.models).map((m) => m.id)).toEqual(['gemini-3-pro']);
    expect(embeddingModels(result.models).map((m) => m.id)).toEqual(['text-embedding-004']);
  });

  it('given_a_model_supporting_neither_method_then_it_is_excluded', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        models: [
          { name: 'models/gemini-3-pro', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/aqa', supportedGenerationMethods: ['generateAnswer'] },
        ],
      })
    );
    const result = await listModels('google', 'k', fetchImpl as unknown as typeof fetch);
    if (!result.ok) throw new Error('expected ok');
    expect(result.models.map((m) => m.id)).toEqual(['gemini-3-pro']);
  });
});

describe('listModels — failures', () => {
  it.each([401, 403])('given_a_%i_then_the_error_names_the_api_key', async (status) => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'nope' }, status));
    const result = await listModels('openai', 'k', fetchImpl as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/rejected this API key/i);
    expect(result.error).toContain('OpenAI');
  });

  it('given_a_429_then_the_error_says_to_retry', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 429));
    const result = await listModels('anthropic', 'k', fetchImpl as unknown as typeof fetch);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toMatch(/rate-limited/i);
    expect(result.error).toContain('Anthropic');
  });

  it('given_a_500_then_the_status_and_body_are_surfaced', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'upstream boom' }, 500));
    const result = await listModels('google', 'k', fetchImpl as unknown as typeof fetch);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('500');
    expect(result.error).toContain('upstream boom');
  });

  it('given_a_network_error_then_it_is_reported_not_thrown', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('Failed to fetch');
    });
    const result = await listModels('openai', 'k', fetchImpl as unknown as typeof fetch);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toMatch(/Could not reach OpenAI/);
    expect(result.error).toContain('Failed to fetch');
  });

  it('given_a_body_that_is_not_json_then_it_fails_with_a_readable_message', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('Unexpected token <');
      },
      text: async () => '<html>',
    }) as unknown as Response);
    const result = await listModels('openai', 'k', fetchImpl as unknown as typeof fetch);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toMatch(/not JSON/i);
  });

  // A restricted key that lists nothing is a real state. Reporting it as a
  // success would leave the user with an empty dropdown and no explanation.
  it('given_a_valid_key_with_an_empty_catalogue_then_it_fails_with_an_explanation', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    const result = await listModels('openai', 'k', fetchImpl as unknown as typeof fetch);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toMatch(/no usable models/i);
  });

  it('given_an_unexpected_payload_shape_then_it_fails_rather_than_throwing', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ unexpected: true }));
    await expect(
      listModels('anthropic', 'k', fetchImpl as unknown as typeof fetch)
    ).resolves.toMatchObject({ ok: false });
  });
});

describe('chatModels / embeddingModels', () => {
  const models: ModelOption[] = [
    { id: 'a', label: 'a', kind: 'chat' },
    { id: 'b', label: 'b', kind: 'embedding' },
  ];

  it('given_a_mixed_list_then_each_helper_returns_only_its_kind', () => {
    expect(chatModels(models).map((m) => m.id)).toEqual(['a']);
    expect(embeddingModels(models).map((m) => m.id)).toEqual(['b']);
  });

  it('given_an_empty_list_then_both_return_empty', () => {
    expect(chatModels([])).toEqual([]);
    expect(embeddingModels([])).toEqual([]);
  });
});
