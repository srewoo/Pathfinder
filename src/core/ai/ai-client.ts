import type { AIProvider } from '../../storage/schemas';
import { OpenAIProvider } from './openai-provider';
import { AnthropicProvider } from './anthropic-provider';
import { GoogleProvider } from './google-provider';
import { embedTextsLocally, isLocalEmbeddingBroken } from './local-embedder';
import { partitionByCache, mergeEmbeddings } from './embedding-cache';
import { isCacheable, buildCacheKey, getCached, setCached } from './response-cache';
import { assertWithinBudget } from './budget-guard';
import { createLogger } from '../../utils/logger';

const log = createLogger('ai-client');

export interface ImageContent {
  type: 'image';
  /** Base64-encoded image data (no data URI prefix). */
  data: string;
  /** MIME type, e.g. 'image/png', 'image/jpeg'. */
  mimeType: string;
}

export interface TextContent {
  type: 'text';
  text: string;
}

export type MessageContent = string | Array<TextContent | ImageContent>;

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: MessageContent;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  /** Override the default fetch timeout (ms). Defaults to 60 000. */
  timeoutMs?: number;
}

export interface AIClientConfig {
  provider: AIProvider;
  apiKey: string;
  model: string;
  embeddingModel: string;
  /** When true, embeddings are computed locally via Transformers.js (free). */
  useLocalEmbeddings: boolean;
}

export interface AIClientInterface {
  chat(messages: Message[], options?: ChatOptions): Promise<string>;
  embed(texts: string[]): Promise<number[][]>;
}

function createChatProvider(config: AIClientConfig): AIClientInterface {
  switch (config.provider) {
    case 'openai':
      return new OpenAIProvider(config.apiKey, config.model, config.embeddingModel);
    case 'anthropic':
      return new AnthropicProvider(config.apiKey, config.model);
    case 'google':
      return new GoogleProvider(config.apiKey, config.model, config.embeddingModel);
    default:
      throw new Error(`Unsupported AI provider: ${config.provider}`);
  }
}

/**
 * Creates an AI client for the configured provider.
 *
 * When `config.useLocalEmbeddings` is true, a hybrid client is returned:
 *   - `chat()` → provider API (OpenAI / Anthropic / Google)
 *   - `embed()` → local Transformers.js model (free, no API key needed)
 *             → auto-fallback to API embeddings if local fails (CSP, WASM error)
 *
 * This lets users with no embedding API access (e.g. Anthropic users) or
 * who want to avoid per-token embedding costs use the local model.
 */
export function createAIClient(config: AIClientConfig): AIClientInterface {
  const chatProvider = createChatProvider(config);

  // Wrap chat with budget guard + deterministic-prompt cache
  const wrappedChat = async (messages: Message[], options?: ChatOptions): Promise<string> => {
    assertWithinBudget(config.model);
    if (isCacheable(options)) {
      const key = buildCacheKey(config.model, messages, options as ChatOptions);
      const cached = getCached(key);
      if (cached !== undefined) {
        log.debug(`Response cache hit (${key})`);
        return cached;
      }
      const response = await chatProvider.chat(messages, options);
      setCached(key, response);
      return response;
    }
    return chatProvider.chat(messages, options);
  };

  // Wrap any embed function with the in-memory LRU cache
  const withEmbeddingCache = (embedFn: (texts: string[]) => Promise<number[][]>) =>
    async (texts: string[]): Promise<number[][]> => {
      const partitioned = partitionByCache(texts);
      if (partitioned.uncachedTexts.length === 0) {
        return partitioned.results as number[][];
      }
      const fresh = await embedFn(partitioned.uncachedTexts);
      return mergeEmbeddings(partitioned, fresh, texts);
    };

  if (config.useLocalEmbeddings) {
    // Wrap local embeddings with auto-fallback to API when local is broken
    // (e.g. Chrome extension CSP blocks ONNX Runtime's eval/new Function).
    const embedWithFallback = async (texts: string[]): Promise<number[][]> => {
      // Fast path: if we already know local is broken, go straight to API
      if (isLocalEmbeddingBroken()) {
        log.info('Local embeddings broken — using API embeddings');
        return chatProvider.embed(texts);
      }

      try {
        return await embedTextsLocally(texts);
      } catch (err) {
        log.warn(
          'Local embedding failed, falling back to API embeddings',
          err instanceof Error ? err.message : String(err)
        );
        return chatProvider.embed(texts);
      }
    };

    return {
      chat: wrappedChat,
      embed: withEmbeddingCache(embedWithFallback),
    };
  }

  return {
    chat: wrappedChat,
    embed: withEmbeddingCache(chatProvider.embed.bind(chatProvider)),
  };
}

export function getDefaultModel(provider: AIProvider): string {
  switch (provider) {
    case 'openai':
      return 'gpt-5';
    case 'anthropic':
      return 'claude-sonnet-4-6';
    case 'google':
      return 'gemini-3-pro';
  }
}

export function getDefaultEmbeddingModel(provider: AIProvider): string {
  switch (provider) {
    case 'openai':
      return 'text-embedding-3-small';
    case 'anthropic':
      return 'text-embedding-3-small';
    case 'google':
      return 'text-embedding-004';
  }
}
