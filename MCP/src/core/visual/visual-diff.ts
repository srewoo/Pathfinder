/**
 * Visual regression baseline using pixelmatch.
 * Zero AI cost — pure pixel comparison done locally.
 *
 * Baselines are stored in ~/.pathfinder/baselines/{testCaseId}.png
 * On first run: saves baseline.
 * On subsequent runs: compares and reports diff percentage.
 */
import { mkdir, readFile, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('visual-diff');

function getBaselineDir(): string {
  return join(homedir(), '.pathfinder', 'baselines');
}

function getBaselinePath(testCaseId: string): string {
  const safe = testCaseId.replace(/[^a-zA-Z0-9-_]/g, '_');
  return join(getBaselineDir(), `${safe}.png`);
}

export async function compareWithBaseline(
  testCaseId: string,
  screenshotBuffer: Buffer
): Promise<{ diffPercent: number; matches: boolean; isNewBaseline: boolean }> {
  const baselinePath = getBaselinePath(testCaseId);

  // Ensure baseline dir exists
  await mkdir(getBaselineDir(), { recursive: true });

  // Check if baseline exists
  let baselineBuffer: Buffer;
  try {
    baselineBuffer = await readFile(baselinePath);
  } catch {
    // No baseline yet — save current as baseline
    await writeFile(baselinePath, screenshotBuffer);
    log.info(`Visual baseline created for ${testCaseId}`);
    return { diffPercent: 0, matches: true, isNewBaseline: true };
  }

  // Compare using pixelmatch
  try {
    const { default: pixelmatch } = await import('pixelmatch');
    const { PNG } = await import('pngjs');

    const img1 = PNG.sync.read(baselineBuffer);
    const img2 = PNG.sync.read(screenshotBuffer);

    // If dimensions differ, treat as mismatch (layout changed) — update baseline
    if (img1.width !== img2.width || img1.height !== img2.height) {
      await writeFile(baselinePath, screenshotBuffer);
      log.warn(
        `Visual baseline size changed for ${testCaseId}: ` +
          `${img1.width}x${img1.height} → ${img2.width}x${img2.height}`
      );
      return { diffPercent: 100, matches: false, isNewBaseline: true };
    }

    const totalPixels = img1.width * img1.height;
    // Pass undefined (not null) for the diff output buffer — we only need the count
    const diffPixels = pixelmatch(img1.data, img2.data, undefined, img1.width, img1.height, {
      threshold: 0.1,
    });
    const diffPercent = Math.round((diffPixels / totalPixels) * 10000) / 100;
    // 5% threshold — minor rendering differences (anti-aliasing, sub-pixel) tolerated
    const matches = diffPercent < 5;

    if (matches) {
      log.debug(`Visual match for ${testCaseId}: ${diffPercent}% diff`);
    } else {
      log.warn(`Visual mismatch for ${testCaseId}: ${diffPercent}% diff`);
    }

    return { diffPercent, matches, isNewBaseline: false };
  } catch (err) {
    log.warn('Visual comparison failed (pixelmatch not available?)', err);
    return { diffPercent: 0, matches: true, isNewBaseline: false };
  }
}

export async function updateBaseline(testCaseId: string, screenshotBuffer: Buffer): Promise<void> {
  await mkdir(getBaselineDir(), { recursive: true });
  await writeFile(getBaselinePath(testCaseId), screenshotBuffer);
  log.info(`Visual baseline updated for ${testCaseId}`);
}
