import type { AIClientInterface, Message, ChatOptions, MessageContent } from './ai-client';
import { createLogger } from '../../utils/logger';

const log = createLogger('openai');

/**
 * Reasoning ("thinking") models — o1, o3, gpt-5 — only accept default
 * temperature (1.0). Sending a custom value returns a 400. Detection by name
 * prefix; new IDs in this family follow the same pattern.
 */
function isReasoningModel(model: string): boolean {
  const m = model.toLowerCase();
  return m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4') || m.startsWith('gpt-5');
}

export class OpenAIProvider implements AIClientInterface {
  private readonly baseUrl = 'https://api.openai.com/v1';
  /** Tracks whether this model needs max_tokens (legacy) vs max_completion_tokens (new). */
  private useMaxCompletionTokens = true;
  /** Whether to send reasoning_effort (stripped if the model rejects it). */
  private useReasoningEffort = true;
  /**
   * Reasoning models bill hidden reasoning tokens against the completion budget,
   * so a small max_tokens (e.g. 200/512) yields EMPTY content — the reasoning
   * alone exhausts it. Floor the budget for these models.
   */
  private static readonly REASONING_MIN_BUDGET = 16_000;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly embeddingModel: string
  ) {}

  async chat(messages: Message[], options: ChatOptions = {}): Promise<string> {
    const { temperature = 0.3, maxTokens = 4096, jsonMode = false, timeoutMs = 60_000 } = options;
    const reasoning = isReasoningModel(this.model);

    const formattedMessages = messages.map((m) => ({ role: m.role, content: formatContentOpenAI(m.content) }));

    // Run a single completion at the given token budget.
    const runCompletion = async (tokenBudget: number) => {
      const body: Record<string, unknown> = {
        model: this.model,
        messages: formattedMessages,
      };

      // Reasoning / "thinking" models (o1, o3, gpt-5.x) only accept the default
      // temperature (1.0). Sending a custom value yields a 400.
      if (!reasoning) {
        body['temperature'] = temperature;
      } else if (this.useReasoningEffort) {
        // Keep reasoning token spend low so it doesn't consume the whole budget
        // (the cause of empty completions). Stripped on 400 if unsupported.
        body['reasoning_effort'] = 'low';
      }

      // Newer models require max_completion_tokens; older use max_tokens.
      if (this.useMaxCompletionTokens) {
        body['max_completion_tokens'] = tokenBudget;
      } else {
        body['max_tokens'] = tokenBudget;
      }

      if (jsonMode) {
        body['response_format'] = { type: 'json_object' };
      }

      let response = await this.fetchChat(body, timeoutMs);

      // Auto-detect rejected params: switch token field / strip temperature /
      // strip reasoning_effort, then retry the same request once per param.
      while (response.status === 400) {
        const errorText = await response.text();
        if (errorText.includes('max_tokens') && errorText.includes('max_completion_tokens')) {
          log.info(`Model ${this.model} requires ${this.useMaxCompletionTokens ? 'max_tokens' : 'max_completion_tokens'}, switching`);
          this.useMaxCompletionTokens = !this.useMaxCompletionTokens;
          delete body['max_tokens'];
          delete body['max_completion_tokens'];
          body[this.useMaxCompletionTokens ? 'max_completion_tokens' : 'max_tokens'] = tokenBudget;
        } else if (errorText.includes("'temperature'") || errorText.toLowerCase().includes('temperature is not supported')) {
          log.info(`Model ${this.model} rejected temperature; retrying without it`);
          delete body['temperature'];
        } else if (errorText.includes('reasoning_effort')) {
          log.info(`Model ${this.model} rejected reasoning_effort; retrying without it`);
          this.useReasoningEffort = false;
          delete body['reasoning_effort'];
        } else {
          throw new Error(`OpenAI API error 400: ${errorText}`);
        }
        response = await this.fetchChat(body, timeoutMs);
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
      if (choice.message?.refusal) {
        throw new Error(`OpenAI refused the request: ${choice.message.refusal}`);
      }

      return { content: choice.message?.content ?? null, finishReason: choice.finish_reason, usage: data.usage };
    };

    // Reasoning models bill reasoning tokens against the budget, so floor it —
    // a 200/512-token request would otherwise return empty content every time.
    const firstBudget = reasoning ? Math.max(maxTokens, OpenAIProvider.REASONING_MIN_BUDGET) : maxTokens;
    let result = await runCompletion(firstBudget);

    // Empty content + finish_reason=length means the budget was exhausted before
    // any visible output. Retry once with a much larger budget.
    if (!result.content && result.finishReason === 'length') {
      const ceiling = reasoning ? 64_000 : 16_384;
      const bumped = Math.min(Math.max(firstBudget * 2, 32_000), ceiling);
      if (bumped > firstBudget) {
        log.warn(`OpenAI returned empty content (finish_reason=length) at ${firstBudget} tokens — retrying with ${bumped}.`);
        result = await runCompletion(bumped);
      }
    }

    if (result.finishReason === 'length' && result.content) {
      log.warn('OpenAI response truncated (finish_reason=length), returning partial content');
    }

    if (!result.content) {
      const usage = result.usage ? ` (completion_tokens=${result.usage.completion_tokens}, prompt_tokens=${result.usage.prompt_tokens})` : '';
      log.error(`OpenAI returned empty content — model=${this.model} finish_reason=${result.finishReason}${usage}`);
      throw new Error(
        `OpenAI returned empty content (finish_reason=${result.finishReason}) from ${this.model}${usage}. ` +
        `If this is a reasoning model, the prompt may be too large for its reasoning budget — try a smaller scope or a non-reasoning model (e.g. gpt-4o).`
      );
    }

    log.debug('Chat completed', { model: this.model, usage: result.usage });
    return result.content;
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
