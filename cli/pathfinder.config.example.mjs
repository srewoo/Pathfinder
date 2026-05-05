// Example pathfinder config. Rename to `pathfinder.config.mjs` at your repo root.
// All fields are optional — flags on the CLI override these values.

/** @type {import('./dist/config.js').PathfinderConfig} */
export default {
  plans: './plans/exported.json',
  browser: 'chromium',
  headless: true,
  concurrency: 4,
  outputDir: './reports',
  baseUrl: 'https://staging.example.com',
  retries: 1,
  reporters: ['html', 'junit', 'json', 'github', 'console'],
};
