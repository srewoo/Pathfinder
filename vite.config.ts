import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';
import path from 'path';

/**
 * Vite injects a `__vitePreload` helper that calls `window.dispatchEvent`.
 * `window` is undefined in Chrome Extension Service Workers (MV3).
 * This plugin rewrites `window.dispatchEvent` → `self.dispatchEvent` in
 * the built output so the preload helper works in both contexts.
 */
function serviceWorkerWindowFix(): Plugin {
  return {
    name: 'service-worker-window-fix',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const [, chunk] of Object.entries(bundle)) {
        if (chunk.type === 'chunk' && chunk.code) {
          chunk.code = chunk.code.replace(
            /window\.dispatchEvent/g,
            '(typeof window !== "undefined" ? window : self).dispatchEvent'
          );
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    crx({ manifest }),
    serviceWorkerWindowFix(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    modulePreload: { polyfill: false },
    minify: false,
    sourcemap: true,
    rollupOptions: {
      output: {
        chunkFileNames: 'assets/[name]-[hash].js',
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
    exclude: ['test/e2e/**'],
    coverage: {
      reporter: ['text', 'lcov'],
      include: ['src/**'],
      exclude: ['src/**/*.test.ts', 'src/sidepanel/index.html'],
    },
  },
});
