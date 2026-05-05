/**
 * Local embedding provider using Transformers.js + ONNX Runtime.
 *
 * Model: Xenova/all-MiniLM-L6-v2  (Sentence Transformers)
 * Dimensions: 384
 * Size: ~23 MB quantized (downloaded once, cached in browser Cache API)
 * Cost: FREE — runs entirely in the service worker, no API calls required.
 *
 * The model is lazy-loaded on first use. Chrome may terminate the service worker
 * after 30 s of inactivity, but the model is re-loaded quickly from cache on the
 * next activation — there is no re-download.
 *
 * NOTE: ONNX Runtime Web's WASM proxy and WebGL backends use eval()/new Function()
 * which Chrome MV3 CSP blocks. We disable proxy mode and force single-threaded WASM
 * to avoid CSP violations. If initialization still fails (e.g. on sites with strict
 * CSP that block even WASM), the AI client falls back to API embeddings automatically.
 */

import { pipeline, env } from '@xenova/transformers';
import { createLogger } from '../../utils/logger';

const log = createLogger('local-embedder');

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

// Allow fetching models from HuggingFace CDN; cache in the browser's Cache API.
env.allowLocalModels = false;
env.useBrowserCache = true;

// ── ONNX Runtime CSP-safe configuration ──────────────────────────────────
// Force WASM-only backend — avoids any WebGL / eval paths that are blocked
// in Chrome MV3 service workers.
env.backends.onnx.wasm.numThreads = 1;

// Disable the WASM web-worker proxy — it uses new Function() internally to
// bootstrap the worker, which violates Chrome extension CSP ('unsafe-eval'
// is not allowed). Running WASM on the main thread is fine for our small model.
env.backends.onnx.wasm.proxy = false;

// Explicitly disable WebGL/WebGPU backends — they compile shaders via
// new Function() which CSP blocks. Only WASM is CSP-safe.
try {
  const onnxEnv = env.backends.onnx as Record<string, unknown>;
  if (onnxEnv.webgl) (onnxEnv.webgl as Record<string, unknown>).disabled = true;
  if (onnxEnv.webgpu) (onnxEnv.webgpu as Record<string, unknown>).disabled = true;
} catch {
  // Older versions of @xenova/transformers may not expose these properties
}

// ── Pipeline management ──────────────────────────────────────────────────

/** Timeout for pipeline initialisation (ms). Prevents hanging on CSP errors. */
const PIPELINE_INIT_TIMEOUT_MS = 60_000;

/** Whether we've already detected that local embeddings are broken in this session. */
let _localEmbeddingsBroken = false;

type EmbeddingPipeline = Awaited<ReturnType<typeof pipeline>>;
let _pipeline: EmbeddingPipeline | null = null;
let _loading: Promise<EmbeddingPipeline> | null = null;

async function getEmbeddingPipeline(
  onProgress?: (percent: number) => void
): Promise<EmbeddingPipeline> {
  if (_localEmbeddingsBroken) {
    throw new Error('Local embeddings unavailable (CSP or WASM error detected earlier). Use API embeddings instead.');
  }

  if (_pipeline) return _pipeline;

  if (_loading) return _loading;

  log.info('Loading local embedding model (first use — downloading from HuggingFace)…');

  // Race the pipeline init against a timeout so it can't hang forever
  // when ONNX Runtime silently fails due to CSP restrictions.
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(
        `Local embedding model failed to initialise within ${PIPELINE_INIT_TIMEOUT_MS / 1000}s. ` +
        'This is usually caused by Chrome extension CSP blocking ONNX Runtime. ' +
        'Falling back to API embeddings.'
      ));
    }, PIPELINE_INIT_TIMEOUT_MS);
  });

  _loading = Promise.race([
    pipeline('feature-extraction', MODEL_ID, {
      quantized: true,
      progress_callback: onProgress
        ? (p: { status: string; progress?: number }) => {
            if (p.status === 'downloading' && typeof p.progress === 'number') {
              onProgress(p.progress);
            }
          }
        : undefined,
    }),
    timeoutPromise,
  ]).then((p) => {
    _pipeline = p;
    _loading = null;
    log.info('Local embedding model ready');
    return p;
  }).catch((err) => {
    _loading = null;
    _localEmbeddingsBroken = true;
    log.error('Local embedding model failed to initialise — marking as broken for this session', err);
    throw err;
  });

  return _loading;
}

export interface LocalEmbedOptions {
  onModelProgress?: (percent: number) => void;
}

/**
 * Embed an array of texts using the local all-MiniLM-L6-v2 model.
 * Returns a 384-dimensional normalised float vector per input text.
 *
 * Throws if the local model is unavailable (CSP, WASM error, etc.).
 * The caller (ai-client.ts) should catch and fallback to API embeddings.
 */
export async function embedTextsLocally(
  texts: string[],
  options: LocalEmbedOptions = {}
): Promise<number[][]> {
  const extractor = await getEmbeddingPipeline(options.onModelProgress);

  const results: number[][] = [];
  for (const text of texts) {
    // Pool token embeddings to a single sentence vector and L2-normalise.
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    // output.data is a Float32Array; convert to a plain JS number array.
    results.push(Array.from(output.data as Float32Array));
  }

  return results;
}

/** Dimension of the local embedding model (all-MiniLM-L6-v2). */
export const LOCAL_EMBEDDING_DIMENSIONS = 384;

/** Whether local embeddings have been detected as broken in this session. */
export function isLocalEmbeddingBroken(): boolean {
  return _localEmbeddingsBroken;
}

/** Release the in-memory pipeline (called on service worker shutdown). */
export function releaseLocalEmbedder(): void {
  _pipeline = null;
  _loading = null;
}
