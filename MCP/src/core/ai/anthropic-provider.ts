import type { AIClientInterface, Message, ChatOptions, MessageContent } from './ai-client.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('anthropic');

export class AnthropicProvider implements AIClientInterface {
  private readonly baseUrl = 'https://api.anthropic.com/v1';

  constructor(
    private readonly apiKey: string,
    private readonly model: string
  ) {}

  async chat(messages: Message[], options: ChatOptions = {}): Promise<string> {
    const { temperature = 0.3, maxTokens = 4096, timeoutMs = 60_000 } = options;

    const systemMessage = messages.find((m) => m.role === 'system');
    const userMessages = messages.filter((m) => m.role !== 'system');

    const response = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        temperature,
        system: typeof systemMessage?.content === 'string' ? systemMessage.content : undefined,
        messages: userMessages.map((m) => ({
          role: m.role,
          content: formatContentAnthropic(m.content),
        })),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${error}`);
    }

    const data = await response.json() as {
      content: Array<{ type: string; text: string }>;
      usage?: { input_tokens: number; output_tokens: number };
    };

    const text = data.content.find((c) => c.type === 'text')?.text;
    if (!text) throw new Error('Anthropic returned empty response');

    if (data.usage) {
      const { recordChatUsage } = await import('./token-tracker.js');
      recordChatUsage(this.model, data.usage.input_tokens, data.usage.output_tokens);
    }

    log.debug('Chat completed', { model: this.model, usage: data.usage });
    return text;
  }

  async embed(texts: string[]): Promise<number[][]> {
    throw new Error(
      'Anthropic does not have a native embedding API. Please switch to OpenAI or Google for embedding generation.'
    );
  }
}

function formatContentAnthropic(content: MessageContent): unknown {
  if (typeof content === 'string') return content;
  return content.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    return { type: 'image', source: { type: 'base64', media_type: part.mimeType, data: part.data } };
  });
}
