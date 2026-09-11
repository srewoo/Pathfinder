import { defineConfig } from 'vite';

/**
 * The real-browser evaluation tier.
 *
 * Its own config and command because it needs a display and a browser install,
 * which CI may not have — and a suite that cannot run must fail loudly rather
 * than be quietly folded into a green run.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/evaluation/browser.test.ts'],
    // Launching Chrome, serving two variants and running every scenario with
    // repeats. Generous on purpose: a timeout here reads as a product failure.
    testTimeout: 300_000,
    hookTimeout: 60_000,
    // One browser at a time; parallel persistent contexts fight over the profile.
    fileParallelism: false,
  },
});
