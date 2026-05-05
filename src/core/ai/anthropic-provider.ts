import type { AIClientInterface, Message, ChatOptions, MessageContent } from './ai-client';
import { createLogger } from '../../utils/logger';

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

    // Anthropic accepts temperature 0–1 inclusive. Models with extended
    // thinking enabled (Claude 4.x with thinking) require temperature=1.0;
    // we don't enable thinking by default, but clamp to [0, 1] defensively.
    const safeTemperature = Math.max(0, Math.min(1, temperature));

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
        temperature: safeTemperature,
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
    };

    const text = data.content.find((c) => c.type === 'text')?.text;
    if (!text) throw new Error('Anthropic returned empty response');

    log.debug('Chat completed', { model: this.model });
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
