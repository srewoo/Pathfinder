import type { AIProvider } from '../../storage/schemas.js';
import { OpenAIProvider } from './openai-provider.js';
import { AnthropicProvider } from './anthropic-provider.js';
import { GoogleProvider } from './google-provider.js';
import { embedTextsLocally, isLocalEmbeddingBroken } from './local-embedder.js';
import { partitionByCache, mergeEmbeddings } from './embedding-cache.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('ai-client');

export interface ImageContent {
  type: 'image';
  data: string;
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
  timeoutMs?: number;
}

export interface AIClientConfig {
  provider: AIProvider;
  apiKey: string;
  model: string;
  embeddingModel: string;
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

export function createAIClient(config: AIClientConfig): AIClientInterface {
  const chatProvider = createChatProvider(config);

  // Wrap embed with LRU cache layer
  const embedWithCache = async (rawEmbed: (texts: string[]) => Promise<number[][]>, texts: string[]): Promise<number[][]> => {
    const partitioned = partitionByCache(texts);
    if (partitioned.uncachedTexts.length === 0) {
      return partitioned.results as number[][];
    }
    const fresh = await rawEmbed(partitioned.uncachedTexts);
    return mergeEmbeddings(partitioned, fresh, texts);
  };

  if (config.useLocalEmbeddings) {
    const rawEmbed = async (texts: string[]): Promise<number[][]> => {
      if (isLocalEmbeddingBroken()) {
        log.info('Local embeddings broken — using API embeddings');
        return chatProvider.embed(texts);
      }
      try {
        return await embedTextsLocally(texts);
      } catch (err) {
        log.warn('Local embedding failed, falling back to API embeddings', err instanceof Error ? err.message : String(err));
        return chatProvider.embed(texts);
      }
    };
    return {
      chat: chatProvider.chat.bind(chatProvider),
      embed: (texts: string[]) => embedWithCache(rawEmbed, texts),
    };
  }

  return {
    chat: chatProvider.chat.bind(chatProvider),
    embed: (texts: string[]) => embedWithCache(chatProvider.embed.bind(chatProvider), texts),
  };
}

export function getDefaultModel(provider: AIProvider): string {
  switch (provider) {
    case 'openai': return 'gpt-4o';
    case 'anthropic': return 'claude-sonnet-4-20250514';
    case 'google': return 'gemini-1.5-pro';
  }
}

export function getDefaultEmbeddingModel(provider: AIProvider): string {
  switch (provider) {
    case 'openai': return 'text-embedding-3-small';
    case 'anthropic': return 'text-embedding-3-small';
    case 'google': return 'text-embedding-004';
  }
}
