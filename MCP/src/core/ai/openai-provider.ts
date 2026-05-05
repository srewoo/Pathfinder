import type { AIClientInterface, Message, ChatOptions, MessageContent } from './ai-client.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('openai');

export class OpenAIProvider implements AIClientInterface {
  private readonly baseUrl = 'https://api.openai.com/v1';
  /** Tracks whether this model needs max_tokens (legacy) vs max_completion_tokens (new). */
  private useMaxCompletionTokens = true;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly embeddingModel: string
  ) {}

  async chat(messages: Message[], options: ChatOptions = {}): Promise<string> {
    const { temperature = 0.3, maxTokens = 4096, jsonMode = false, timeoutMs = 60_000 } = options;

    const formattedMessages = messages.map((m) => ({ role: m.role, content: formatContentOpenAI(m.content) }));

    const body: Record<string, unknown> = {
      model: this.model,
      messages: formattedMessages,
      temperature,
    };

    // Newer models (o1, o3, gpt-5.x) require max_completion_tokens;
    // older models (gpt-4o, gpt-4-turbo) use max_tokens.
    // Try the current mode and auto-switch on 400 error.
    if (this.useMaxCompletionTokens) {
      body['max_completion_tokens'] = maxTokens;
    } else {
      body['max_tokens'] = maxTokens;
    }

    if (jsonMode) {
      body['response_format'] = { type: 'json_object' };
    }

    let response = await this.fetchChat(body, timeoutMs);

    // Auto-detect: if the model rejects the token parameter, switch and retry once
    if (response.status === 400) {
      const errorText = await response.text();
      if (errorText.includes('max_tokens') && errorText.includes('max_completion_tokens')) {
        log.info(`Model ${this.model} requires ${this.useMaxCompletionTokens ? 'max_tokens' : 'max_completion_tokens'}, switching`);
        this.useMaxCompletionTokens = !this.useMaxCompletionTokens;
        delete body['max_tokens'];
        delete body['max_completion_tokens'];
        if (this.useMaxCompletionTokens) {
          body['max_completion_tokens'] = maxTokens;
        } else {
          body['max_tokens'] = maxTokens;
        }
        response = await this.fetchChat(body, timeoutMs);
      } else {
        throw new Error(`OpenAI API error 400: ${errorText}`);
      }
    }

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${error}`);
    }

    const data = await response.json() as {
      choices: Array<{
        message: { content: string | null; refusal?: string | null };
        finish_reason: string;
      }>;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    const choice = data.choices?.[0];
    if (!choice) {
      log.error('OpenAI returned no choices', { data });
      throw new Error('OpenAI returned no choices in response');
    }

    // Handle refusals (content moderation)
    if (choice.message?.refusal) {
      throw new Error(`OpenAI refused the request: ${choice.message.refusal}`);
    }

    // Handle truncation — the model hit the token limit before finishing
    if (choice.finish_reason === 'length') {
      log.warn('OpenAI response truncated (finish_reason=length), returning partial content');
    }

    const content = choice.message?.content;
    if (!content) {
      log.error('OpenAI returned empty content', { finish_reason: choice.finish_reason, model: this.model, usage: data.usage });
      throw new Error(`OpenAI returned empty content (finish_reason=${choice.finish_reason}). Model may need a higher max_tokens or the prompt may be too large.`);
    }

    if (data.usage) {
      const { recordChatUsage } = await import('./token-tracker.js');
      recordChatUsage(this.model, data.usage.prompt_tokens, data.usage.completion_tokens);
    }

    log.debug('Chat completed', { model: this.model, usage: data.usage });
    return content;
  }

  private fetchChat(body: Record<string, unknown>, timeoutMs: number): Promise<Response> {
    return fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async embed(texts: string[]): Promise<number[][]> {
    const BATCH_SIZE = 100;
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);

      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.embeddingModel,
          input: batch,
          encoding_format: 'float',
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`OpenAI Embeddings error ${response.status}: ${error}`);
      }

      const data = await response.json() as {
        data: Array<{ embedding: number[] }>;
      };

      results.push(...data.data.map((d) => d.embedding));
    }

    return results;
  }
}

function formatContentOpenAI(content: MessageContent): unknown {
  if (typeof content === 'string') return content;
  return content.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    return { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data}`, detail: 'low' } };
  });
}
