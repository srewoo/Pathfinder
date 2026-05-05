/**
 * Generates PNG icons at 16, 32, 48, and 128px from public/icons/icon.svg.
 * Run automatically via the `prebuild:chrome` and `prebuild:zip` hooks,
 * or manually via `npm run icons`.
 */

import sharp from 'sharp';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const svgPath = resolve(root, 'public', 'icons', 'icon.svg');
const iconsDir = resolve(root, 'public', 'icons');

const SIZES = [16, 32, 48, 128];

if (!existsSync(svgPath)) {
  console.error(`SVG source not found: ${svgPath}`);
  process.exit(1);
}

const svg = readFileSync(svgPath);

await Promise.all(
  SIZES.map(async (size) => {
    const dest = resolve(iconsDir, `icon${size}.png`);
    await sharp(svg)
      .resize(size, size)
      .png({ compressionLevel: 9 })
      .toFile(dest);
    console.log(`  ✓ icon${size}.png (${size}×${size})`);
  })
);

console.log('\nAll icons generated in public/icons/');
