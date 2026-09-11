import { defineConfig } from 'vite';

/**
 * The evaluation suite — a separate command on purpose.
 *
 * The plan requires deterministic extension/browser evaluation to be kept apart
 * from the unit and integration suites, for two reasons that both matter:
 *
 *  - It is slower. Every scenario parses real HTML and runs its scripts, and the
 *    stability scenarios repeat five times. Folding that into `npm test` would
 *    make the fast suite slow enough that people stop running it.
 *  - It answers a different question. `npm test` asks "is the code correct";
 *    this asks "does the product find the bug and not cry wolf". A run that
 *    reports 0 false positives and 6 of 8 detections is useful output, not a
 *    pass/fail — and mixing the two makes the second unreadable.
 *
 * `node` environment, not `jsdom`: the harness constructs its own jsdom per
 * page, and a global one would shadow it confusingly.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // The browser tier has its own config and command — it needs a display,
    // so including it here would make `npm run evaluate` fail on a headless box.
    include: ['test/evaluation/**/*.test.ts'],
    exclude: ['test/evaluation/browser.test.ts'],
    // Scenario pages run real timers; the stability scenarios repeat five times.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
