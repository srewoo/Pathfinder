import type { AIClientInterface } from '../ai/ai-client';
import type { ExtractedImage } from './extractor';
import { createLogger } from '../../utils/logger';

const log = createLogger('image-describer');

/** Max images to describe per page to keep cost reasonable. */
const MAX_IMAGES_PER_PAGE = 10;

/** Max concurrent vision API calls. */
const CONCURRENCY = 3;

const IMAGE_PROMPT =
  'Describe this image from a help/documentation article. Focus on: UI elements visible (buttons, form fields, menus, labels), workflow steps shown, navigation paths, and any annotated instructions. Be concise — 2-4 sentences. If this is a decorative or irrelevant image, respond with just "decorative".';

/**
 * Fetches images from a crawled page and describes them using the vision LLM.
 * Returns a map of image placeholder → AI description so the caller can
 * replace placeholders in the extracted text content.
 */
export async function describePageImages(
  images: ExtractedImage[],
  pageUrl: string,
  aiClient: AIClientInterface
): Promise<Map<string, string>> {
  const descriptions = new Map<string, string>();

  // Filter to meaningful images and cap the count
  const candidates = images
    .filter((img) => !img.src.startsWith('data:image/svg'))
    .slice(0, MAX_IMAGES_PER_PAGE);

  if (candidates.length === 0) return descriptions;

  log.info(`Describing ${candidates.length} images from ${pageUrl}`);

  // Process in batches of CONCURRENCY
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY);

    const results = await Promise.allSettled(
      batch.map(async (img) => {
        const describeOnce = async () => {
          const imageData = await fetchImageAsBase64(img.src);
          if (!imageData) return null;

          const description = await aiClient.chat(
            [
              { role: 'system', content: 'You are analyzing images from product documentation and help articles for a QA testing tool.' },
              {
                role: 'user',
                content: [
                  { type: 'image', data: imageData.base64, mimeType: imageData.mimeType },
                  { type: 'text', text: IMAGE_PROMPT },
                ],
              },
            ],
            { temperature: 0.1, maxTokens: 300 }
          );

          const trimmed = description.trim();
          if (trimmed.toLowerCase() === 'decorative') return null;
          return { placeholder: img.placeholder, description: trimmed };
        };

        // Retry once on transient failures (rate limit, server errors)
        try {
          return await describeOnce();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('429') || msg.includes('502') || msg.includes('503') || msg.includes('timeout')) {
            log.debug(`Retrying image description for ${img.src} after transient error`);
            await new Promise((r) => setTimeout(r, 2000));
            try {
              return await describeOnce();
            } catch (retryErr) {
              log.warn(`Image description retry failed for ${img.src}`, retryErr);
              return null;
            }
          }
          log.warn(`Failed to describe image ${img.src}`, err);
          return null;
        }
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        descriptions.set(result.value.placeholder, result.value.description);
      }
    }
  }

  log.info(`Described ${descriptions.size}/${candidates.length} images from ${pageUrl}`);
  return descriptions;
}

/**
 * Replaces image placeholders in text content with AI-generated descriptions.
 */
export function injectImageDescriptions(
  content: string,
  descriptions: Map<string, string>
): string {
  let result = content;
  for (const [placeholder, description] of descriptions) {
    result = result.replace(
      placeholder,
      `[Image: ${description}]`
    );
  }
  return result;
}

// ── Internal ────────────────────────────────────────────────────────────────

interface ImageData {
  base64: string;
  mimeType: string;
}

async function fetchImageAsBase64(src: string): Promise<ImageData | null> {
  try {
    const response = await fetch(src, {
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return null;

    const contentType = response.headers.get('content-type') ?? '';
    const mimeType = contentType.split(';')[0].trim();

    // Only process actual images
    if (!mimeType.startsWith('image/')) return null;

    // Skip SVGs — not useful for vision
    if (mimeType === 'image/svg+xml') return null;

    const buffer = await response.arrayBuffer();

    // Skip images smaller than 2KB (likely icons/spacers)
    if (buffer.byteLength < 2048) return null;

    // Skip images larger than 5MB (too expensive to send)
    if (buffer.byteLength > 5 * 1024 * 1024) return null;

    const base64 = arrayBufferToBase64(buffer);
    return { base64, mimeType };
  } catch {
    return null;
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
