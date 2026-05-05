/**
 * Local embedding provider using Transformers.js + ONNX Runtime.
 *
 * Model: Xenova/all-MiniLM-L6-v2  (Sentence Transformers)
 * Dimensions: 384
 * Size: ~23 MB quantized (downloaded once, cached locally)
 * Cost: FREE — runs entirely in-process, no API calls required.
 *
 * The model is lazy-loaded on first use and kept in memory for the
 * lifetime of the server process.
 */

import { pipeline, env } from '@xenova/transformers';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('local-embedder');

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

// Allow fetching models from HuggingFace CDN; cache locally.
env.allowLocalModels = false;

// ── Pipeline management ──────────────────────────────────────────────────

/** Timeout for pipeline initialisation (ms). */
const PIPELINE_INIT_TIMEOUT_MS = 120_000;

/** Whether we've already detected that local embeddings are broken in this session. */
let _localEmbeddingsBroken = false;

type EmbeddingPipeline = Awaited<ReturnType<typeof pipeline>>;
let _pipeline: EmbeddingPipeline | null = null;
let _loading: Promise<EmbeddingPipeline> | null = null;

async function getEmbeddingPipeline(): Promise<EmbeddingPipeline> {
  if (_localEmbeddingsBroken) {
    throw new Error('Local embeddings unavailable. Use API embeddings instead.');
  }

  if (_pipeline) return _pipeline;

  if (_loading) return _loading;

  log.info('Loading local embedding model...');

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error('Local embedding model init timeout'));
    }, PIPELINE_INIT_TIMEOUT_MS);
  });

  _loading = Promise.race([
    pipeline('feature-extraction', MODEL_ID, { quantized: true }),
    timeoutPromise,
  ]).then((p) => {
    _pipeline = p;
    _loading = null;
    log.info('Local embedding model ready');
    return p;
  }).catch((err) => {
    _loading = null;
    _localEmbeddingsBroken = true;
    log.error('Local embedding model failed to initialise', err);
    throw err;
  });

  return _loading;
}

/**
 * Embed an array of texts using the local all-MiniLM-L6-v2 model.
 * Returns a 384-dimensional normalised float vector per input text.
 *
 * Throws if the local model is unavailable.
 * The caller (ai-client.ts) should catch and fallback to API embeddings.
 */
export async function embedTextsLocally(texts: string[]): Promise<number[][]> {
  const extractor = await getEmbeddingPipeline();

  const results: number[][] = [];
  for (const text of texts) {
    // Pool token embeddings to a single sentence vector and L2-normalise.
    const output = await extractor(text, { pooling: 'mean', normalize: true } as any);
    // output.data is a Float32Array; convert to a plain JS number array.
    results.push(Array.from((output as any).data as Float32Array));
  }

  return results;
}

/** Dimension of the local embedding model (all-MiniLM-L6-v2). */
export const LOCAL_EMBEDDING_DIMENSIONS = 384;

/** Whether local embeddings have been detected as broken in this session. */
export function isLocalEmbeddingBroken(): boolean {
  return _localEmbeddingsBroken;
}

/** Release the in-memory pipeline (called on server shutdown). */
export function releaseLocalEmbedder(): void {
  _pipeline = null;
  _loading = null;
}
