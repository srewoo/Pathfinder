import type { AIClientInterface, Message, ChatOptions, MessageContent } from './ai-client.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('google');

export class GoogleProvider implements AIClientInterface {
  private readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta';

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly embeddingModel: string
  ) {}

  async chat(messages: Message[], options: ChatOptions = {}): Promise<string> {
    const { temperature = 0.3, maxTokens = 4096, timeoutMs = 60_000 } = options;

    const systemInstruction = messages.find((m) => m.role === 'system');
    const conversationMessages = messages.filter((m) => m.role !== 'system');

    const contents = conversationMessages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: formatPartsGoogle(m.content),
    }));

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
      },
    };

    if (systemInstruction) {
      body['systemInstruction'] = {
        parts: [{ text: systemInstruction.content }],
      };
    }

    const response = await fetch(
      `${this.baseUrl}/models/${this.model}:generateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Google AI error ${response.status}: ${error}`);
    }

    const data = await response.json() as {
      candidates: Array<{
        content: { parts: Array<{ text: string }> };
      }>;
      usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number; totalTokenCount: number };
    };

    const text = data.candidates[0]?.content?.parts[0]?.text;
    if (!text) throw new Error('Google AI returned empty response');

    if (data.usageMetadata) {
      const { recordChatUsage } = await import('./token-tracker.js');
      recordChatUsage(this.model, data.usageMetadata.promptTokenCount, data.usageMetadata.candidatesTokenCount);
    }

    log.debug('Chat completed', { model: this.model, usage: data.usageMetadata });
    return text;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const BATCH_SIZE = 100;
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);

      const requests = batch.map((text) => ({
        model: `models/${this.embeddingModel}`,
        content: { parts: [{ text }] },
      }));

      const response = await fetch(
        `${this.baseUrl}/models/${this.embeddingModel}:batchEmbedContents?key=${this.apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests }),
          signal: AbortSignal.timeout(30000),
        }
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Google Embeddings error ${response.status}: ${error}`);
      }

      const data = await response.json() as {
        embeddings: Array<{ values: number[] }>;
      };

      results.push(...data.embeddings.map((e) => e.values));
    }

    return results;
  }
}

function formatPartsGoogle(content: MessageContent): unknown[] {
  if (typeof content === 'string') return [{ text: content }];
  return content.map((part) => {
    if (part.type === 'text') return { text: part.text };
    return { inlineData: { mimeType: part.mimeType, data: part.data } };
  });
}
