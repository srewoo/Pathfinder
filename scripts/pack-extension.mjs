/**
 * Packs the dist/ folder into a versioned zip for Chrome Web Store submission.
 * Usage: node scripts/pack-extension.mjs
 */

import archiver from 'archiver';
import { createWriteStream, readFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const distDir = resolve(root, 'dist');
const releaseDir = resolve(root, 'releases');

const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf-8'));
const version = manifest.version ?? '1.0.0';
const name = (manifest.name ?? 'pathfinder').toLowerCase().replace(/\s+/g, '-');
const zipName = `${name}-v${version}.zip`;
const zipPath = resolve(releaseDir, zipName);

mkdirSync(releaseDir, { recursive: true });

const output = createWriteStream(zipPath);
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', () => {
  const kb = (archive.pointer() / 1024).toFixed(1);
  console.log(`\n✓ Chrome Web Store package ready`);
  console.log(`  File : releases/${zipName}`);
  console.log(`  Size : ${kb} KB (${archive.pointer()} bytes)`);
  console.log(`\nUpload to: https://chrome.google.com/webstore/devconsole`);
});

archive.on('warning', (err) => {
  if (err.code === 'ENOENT') {
    console.warn('Warning:', err.message);
  } else {
    throw err;
  }
});

archive.on('error', (err) => { throw err; });

archive.pipe(output);
archive.directory(distDir, false);
archive.finalize();
