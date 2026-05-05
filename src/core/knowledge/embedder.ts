import type { AIClientInterface } from '../ai/ai-client';
import type { Chunk } from './chunker';
import type { VectorRecord } from '../../storage/schemas';
import { generateId } from '../../utils/hash';
import { createLogger } from '../../utils/logger';

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

    let embeddings: number[][] = [];
    try {
      embeddings = await embedWithRetry(aiClient, texts, 3);
    } catch (err) {
      // Per-chunk resilience: log the batch failure but continue with other batches
      // instead of failing the entire page.
      log.error(`Embedding batch failed after retries (batch starting at chunk ${i}), skipping ${batch.length} chunks`, err);
      continue;
    }

    batch.forEach((chunk, j) => {
      if (embeddings[j]) {
        // Store as Float32Array — halves storage vs number[] (4 bytes vs 8 bytes per element).
        // IndexedDB's structured clone handles TypedArrays natively.
        records.push({
          id: generateId(),
          content: chunk.content,
          url,
          embedding: new Float32Array(embeddings[j]) as unknown as number[],
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
      } else {
        log.warn(`Embedding missing for chunk ${chunk.index} of ${url} — API returned fewer embeddings than texts`);
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

/** Timeout for a single embed API call (60 seconds). */
const EMBED_TIMEOUT_MS = 60_000;

async function embedWithRetry(
  aiClient: AIClientInterface,
  texts: string[],
  maxRetries: number
): Promise<number[][]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Wrap in a timeout to prevent indefinite hangs if the API stalls
      const result = await Promise.race([
        aiClient.embed(texts),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Embed API timeout after ${EMBED_TIMEOUT_MS}ms`)), EMBED_TIMEOUT_MS)
        ),
      ]);
      return result;
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
