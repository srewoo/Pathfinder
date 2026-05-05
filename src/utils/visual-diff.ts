/**
 * Visual screenshot comparison using pixel-level diffing.
 *
 * Pure JavaScript implementation (no native dependencies) that runs in
 * the Chrome extension service worker or content script.
 *
 * Uses a simplified pixelmatch algorithm:
 * 1. Decode both PNG data URLs into raw RGBA pixel arrays via OffscreenCanvas
 * 2. Compare pixel-by-pixel with configurable color tolerance
 * 3. Return diff percentage and optional diff image
 */
import { createLogger } from './logger';

const log = createLogger('visual-diff');

export interface DiffResult {
  /** Percentage of pixels that differ (0-100) */
  diffPercent: number;
  /** Total number of pixels compared */
  totalPixels: number;
  /** Number of pixels that differ */
  diffPixels: number;
  /** Whether the images match within the threshold */
  matches: boolean;
  /** Base64 data URL of the diff image (pink highlighting differences) */
  diffImage?: string;
  /** Width of the compared images */
  width: number;
  /** Height of the compared images */
  height: number;
}

export interface DiffOptions {
  /** Maximum percentage of different pixels allowed for a "match" (default: 1.0) */
  threshold?: number;
  /** Per-channel color tolerance 0-255 (default: 25 — handles anti-aliasing) */
  colorTolerance?: number;
  /** Generate a visual diff image (default: true) */
  generateDiffImage?: boolean;
}

/**
 * Compare two screenshots (as data URLs) and return the diff result.
 *
 * Both images are decoded, resized to the same dimensions if needed,
 * and compared pixel-by-pixel.
 */
export async function compareScreenshots(
  baselineDataUrl: string,
  currentDataUrl: string,
  options: DiffOptions = {}
): Promise<DiffResult> {
  const { threshold = 1.0, colorTolerance = 25, generateDiffImage = true } = options;

  try {
    // Decode images to ImageData via OffscreenCanvas
    const [baselineData, currentData] = await Promise.all([
      decodeDataUrl(baselineDataUrl),
      decodeDataUrl(currentDataUrl),
    ]);

    // Use the smaller dimensions for comparison
    const width = Math.min(baselineData.width, currentData.width);
    const height = Math.min(baselineData.height, currentData.height);
    const totalPixels = width * height;

    const basePixels = baselineData.data;
    const currPixels = currentData.data;

    // Create diff image buffer if requested
    let diffPixelData: Uint8ClampedArray | undefined;
    if (generateDiffImage) {
      diffPixelData = new Uint8ClampedArray(width * height * 4);
    }

    let diffCount = 0;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const baseIdx = (y * baselineData.width + x) * 4;
        const currIdx = (y * currentData.width + x) * 4;
        const diffIdx = (y * width + x) * 4;

        const dr = Math.abs(basePixels[baseIdx] - currPixels[currIdx]);
        const dg = Math.abs(basePixels[baseIdx + 1] - currPixels[currIdx + 1]);
        const db = Math.abs(basePixels[baseIdx + 2] - currPixels[currIdx + 2]);

        const isDiff = dr > colorTolerance || dg > colorTolerance || db > colorTolerance;

        if (isDiff) {
          diffCount++;
          if (diffPixelData) {
            // Highlight diff pixels in magenta
            diffPixelData[diffIdx] = 255;     // R
            diffPixelData[diffIdx + 1] = 0;   // G
            diffPixelData[diffIdx + 2] = 255; // B
            diffPixelData[diffIdx + 3] = 200; // A
          }
        } else if (diffPixelData) {
          // Non-diff pixels: dimmed version of current image
          diffPixelData[diffIdx] = currPixels[currIdx] >> 1;
          diffPixelData[diffIdx + 1] = currPixels[currIdx + 1] >> 1;
          diffPixelData[diffIdx + 2] = currPixels[currIdx + 2] >> 1;
          diffPixelData[diffIdx + 3] = 255;
        }
      }
    }

    const diffPercent = (diffCount / totalPixels) * 100;
    const matches = diffPercent <= threshold;

    let diffImage: string | undefined;
    if (diffPixelData && generateDiffImage) {
      diffImage = await encodeDiffImage(diffPixelData, width, height);
    }

    return {
      diffPercent: Math.round(diffPercent * 100) / 100,
      totalPixels,
      diffPixels: diffCount,
      matches,
      diffImage,
      width,
      height,
    };
  } catch (err) {
    log.warn('Visual diff failed', err);
    return {
      diffPercent: 100,
      totalPixels: 0,
      diffPixels: 0,
      matches: false,
      width: 0,
      height: 0,
    };
  }
}

/**
 * Decode a data URL into raw ImageData using OffscreenCanvas.
 * Works in service workers (no DOM canvas needed).
 */
async function decodeDataUrl(dataUrl: string): Promise<ImageData> {
  // Extract base64 data
  const base64Match = dataUrl.match(/^data:image\/\w+;base64,(.+)$/);
  if (!base64Match) throw new Error('Invalid data URL format');

  const binaryString = atob(base64Match[1]);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  const blob = new Blob([bytes], { type: 'image/png' });
  const bitmap = await createImageBitmap(blob);

  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);

  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

/**
 * Encode raw pixel data back to a PNG data URL via OffscreenCanvas.
 */
async function encodeDiffImage(pixelData: Uint8ClampedArray, width: number, height: number): Promise<string> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  const imageData = new ImageData(pixelData as unknown as Uint8ClampedArray, width, height);
  ctx.putImageData(imageData, 0, 0);

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const buffer = await blob.arrayBuffer();
  const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
  return `data:image/png;base64,${base64}`;
}
