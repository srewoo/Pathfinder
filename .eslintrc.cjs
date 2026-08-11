/**
 * ESLint config.
 *
 * Beyond ordinary linting, this file carries two ARCHITECTURAL boundaries that
 * fix.md relies on. Both were previously stated as conventions and therefore
 * eroded; encoded here they fail the build instead.
 *
 *   §2 — `src/core/**` must not touch `chrome.*`. The core is pure TS so it can
 *        be unit-tested against the fake driver with no browser.
 *   §6 — `src/core/executor/**` must not import `src/core/ai/**`. The executor
 *        consumes validated IR only; no LLM call may sit on the execution path.
 *
 * The `BURN_DOWN` lists below are pre-existing violations, not exemptions. Each
 * entry is a file that must be migrated; the rule already blocks NEW violations
 * everywhere else. Delete entries as they are fixed — never add.
 */

/**
 * §6 — CLEARED. No exemptions remain.
 *
 * `core/executor/**` no longer imports the AI layer at all. Planning, healing and
 * assertion generation arrive through the ports in
 * `core/executor/execution-ports.ts`, implemented in
 * `core/planner/ai-execution-services.ts`, so any reintroduction fails the build.
 */

/** §2 — files under src/core that still reach for chrome.* directly. */
const BURN_DOWN_CHROME_IN_CORE = [
  // CDP transport. Legitimately chrome-coupled; slated to move to src/drivers/.
  'src/core/cdp/cdp-client.ts',
  'src/core/cdp/screencast.ts',
  // Orchestrators awaiting the Phase 3 job-state-machine refactor (§4).
  'src/core/explorer/explorer-agent.ts',
  'src/core/knowledge/crawler.ts',
  // Executor internals awaiting driver injection (§3).
  'src/core/executor/auth-manager.ts',
  'src/core/executor/preflight.ts',
  'src/core/executor/step-extensions.ts',
  'src/core/executor/action-runner.ts',
  'src/core/executor/test-executor.ts',
];

module.exports = {
  root: true,
  env: { browser: true, es2022: true, webextensions: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  plugins: ['@typescript-eslint', 'react-hooks', 'react-refresh'],
  ignorePatterns: [
    'dist',
    'coverage',
    'node_modules',
    'releases',
    '*.cjs',
    'scripts/**',
    'docs/**',
  ],
  rules: {
    // `any` defeats the type system; CLAUDE.md §2 bans it outright.
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    // Errors must be logged or re-thrown with context — never swallowed.
    'no-empty': ['error', { allowEmptyCatch: true }],
    'no-var': 'error',
    'prefer-const': 'error',
    eqeqeq: ['error', 'smart'],
    'no-eval': 'error',
    'no-implied-eval': 'error',
  },
  overrides: [
    // ── §2: no chrome.* inside the core ──────────────────────────────────────
    {
      files: ['src/core/**/*.ts'],
      excludedFiles: BURN_DOWN_CHROME_IN_CORE,
      rules: {
        'no-restricted-globals': [
          'error',
          {
            name: 'chrome',
            message:
              'fix.md §2: src/core must not touch chrome.*. Depend on the Driver port ' +
              '(src/core/driver.ts) and let src/drivers/* provide the implementation.',
          },
        ],
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['**/drivers/*', '**/../drivers/**'],
                message:
                  'fix.md §2: core must depend on the Driver INTERFACE, not a concrete driver. ' +
                  'Accept a Driver parameter instead of importing one.',
              },
            ],
          },
        ],
      },
    },

    // ── §6: the executor may not reach for the AI layer ─────────────────────
    {
      files: ['src/core/executor/**/*.ts'],
      // NO excludedFiles: the §6 burn-down is empty, and passing an empty array
      // here silently disables the whole override.
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['**/ai/*', '**/core/ai/**', '../ai/*', '../../core/ai/*'],
                message:
                  'fix.md §6: the executor consumes validated TestIR only and must contain ' +
                  'zero LLM calls. Generate the IR upstream, then execute it.',
              },
            ],
          },
        ],
      },
    },

    // Test files may reach anywhere — that is the point of a test.
    {
      files: ['test/**/*.ts', '**/*.test.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        'no-restricted-globals': 'off',
        'no-restricted-imports': 'off',
      },
    },
  ],
};
