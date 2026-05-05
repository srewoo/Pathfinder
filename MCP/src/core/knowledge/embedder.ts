import type { AIClientInterface } from '../ai/ai-client.js';
import type { Chunk } from './chunker.js';
import type { VectorRecord } from '../../storage/schemas.js';
import { generateId } from '../../utils/hash.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('embedder');

// Larger batch → fewer round-trips to the embedding API.
// OpenAI, Anthropic, and Google all support 50+ texts per call.
const EMBED_BATCH_SIZE = 50;
/**
 * Delay between embedding batches when using API providers.
 * Applied only when `skipRateLimit` is false (the default).
 * Set `skipRateLimit: true` for local models — they have no API rate limits.
 */
const RATE_LIMIT_MS = 500;

export interface EmbedOptions {
  onProgress?: (embedded: number, total: number) => void;
  /**
   * Skip the inter-batch rate-limit delay.
   * Should be true when using the local Transformers.js model.
   */
  skipRateLimit?: boolean;
  /** Identifier for the embedding model used (stored in vector metadata for version tracking) */
  modelId?: string;
}

export async function embedChunks(
  chunks: Chunk[],
  url: string,
  title: string,
  aiClient: AIClientInterface,
  options: EmbedOptions = {}
): Promise<VectorRecord[]> {
  const { skipRateLimit = false, onProgress, modelId } = options;
  const records: VectorRecord[] = [];
  const total = chunks.length;

  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    const texts = batch.map((c) => c.content);

    let embeddings: number[][];
    try {
      embeddings = await embedWithRetry(aiClient, texts, 3);
    } catch (err) {
      log.error('Embedding batch failed after retries', { batchStart: i, err });
      throw err;
    }

    batch.forEach((chunk, j) => {
      if (embeddings[j]) {
        records.push({
          id: generateId(),
          content: chunk.content,
          url,
          embedding: embeddings[j],
          metadata: {
            title,
            section: chunk.parentHeading || extractSection(chunk.content),
            breadcrumbPath: extractBreadcrumb(url),
            crawledAt: new Date().toISOString(),
            chunkIndex: chunk.index,
            totalChunks: total,
            ...(modelId ? { embeddingModel: modelId } : {}),
          },
        });
      }
    });

    onProgress?.(Math.min(i + EMBED_BATCH_SIZE, total), total);

    // Only wait between batches when using an API provider (rate limit courtesy).
    // Local models run in-process with no external rate limits.
    if (!skipRateLimit && i + EMBED_BATCH_SIZE < chunks.length) {
      await delay(RATE_LIMIT_MS);
    }
  }

  return records;
}

function extractBreadcrumb(url: string): string {
  try {
    const { pathname } = new URL(url);
    return pathname
      .split('/')
      .filter(Boolean)
      .map((seg) => seg.replace(/[-_]/g, ' ').replace(/\.\w+$/, ''))
      .join(' > ');
  } catch {
    return '';
  }
}

function extractSection(content: string): string {
  const headingMatch = content.match(/^##\s+(.+)/m);
  if (headingMatch?.[1]) return headingMatch[1].trim();

  const firstLine = content.split('\n')[0]?.trim();
  return firstLine?.slice(0, 60) ?? '';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function embedWithRetry(
  aiClient: AIClientInterface,
  texts: string[],
  maxRetries: number
): Promise<number[][]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await aiClient.embed(texts);
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries - 1) {
        const backoff = Math.min(1000 * Math.pow(2, attempt), 8000);
        const jitter = Math.random() * backoff * 0.3;
        log.warn(`Embed attempt ${attempt + 1} failed, retrying in ${Math.round(backoff + jitter)}ms`, err);
        await delay(backoff + jitter);
      }
    }
  }
  throw lastError;
}
