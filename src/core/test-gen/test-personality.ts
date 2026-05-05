/**
 * Prompt-Tunable Test Personality.
 *
 * Allows users to choose what kind of tester they want — from a cautious
 * happy-path validator to an aggressive edge-case finder or security-focused
 * penetration tester. The personality adjusts:
 *
 * 1. System prompt tone and focus areas
 * 2. AI temperature (deterministic → creative)
 * 3. Negative/edge test ratio
 * 4. Specific test categories to emphasize
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type TestPersonalityId =
  | 'balanced'
  | 'happy_path'
  | 'aggressive_edge'
  | 'security_focused'
  | 'accessibility_first'
  | 'performance_minded'
  | 'custom';

export interface TestPersonality {
  id: TestPersonalityId;
  name: string;
  description: string;
  /** AI temperature for test generation (0.0–1.0) */
  temperature: number;
  /** Ratio of test types to generate: [positive, negative, edge] — must sum to 1.0 */
  testTypeWeights: { positive: number; negative: number; edge: number };
  /** Additional system prompt instructions injected into test generation */
  systemPromptOverlay: string;
  /** Specific test categories to emphasize */
  emphasisAreas: string[];
  /** Max tests to generate per flow (more aggressive = more tests) */
  maxTestsPerFlow: number;
}

// ── Built-in Personalities ─────────────────────────────────────────────────

export const PERSONALITIES: Record<Exclude<TestPersonalityId, 'custom'>, TestPersonality> = {
  balanced: {
    id: 'balanced',
    name: 'Balanced',
    description: 'Well-rounded testing — covers happy paths, common edge cases, and basic negative scenarios.',
    temperature: 0.4,
    testTypeWeights: { positive: 0.3, negative: 0.4, edge: 0.3 },
    systemPromptOverlay: '',
    emphasisAreas: [],
    maxTestsPerFlow: 12,
  },

  happy_path: {
    id: 'happy_path',
    name: 'Happy Path Validator',
    description: 'Focuses on verifying that core workflows succeed with valid data. Minimal negative testing.',
    temperature: 0.2,
    testTypeWeights: { positive: 0.7, negative: 0.2, edge: 0.1 },
    systemPromptOverlay: `
PERSONALITY OVERRIDE — HAPPY PATH FOCUS:
- Prioritize positive tests that verify core user journeys succeed end-to-end.
- For each workflow, ensure the "golden path" (most common user flow) has a thorough test.
- Only include 1-2 negative tests for the most critical validation rules.
- Skip obscure edge cases — focus on what a typical user would actually do.
- Every test should tell a story: "As a user, I want to [action], so I can [outcome]".
- Verify success states thoroughly: confirmation messages, data persistence, navigation.`,
    emphasisAreas: ['core-workflow', 'success-state', 'user-journey'],
    maxTestsPerFlow: 8,
  },

  aggressive_edge: {
    id: 'aggressive_edge',
    name: 'Aggressive Edge-Case Finder',
    description: 'Actively tries to break the application. Boundary values, special characters, race conditions, unusual inputs.',
    temperature: 0.7,
    testTypeWeights: { positive: 0.1, negative: 0.4, edge: 0.5 },
    systemPromptOverlay: `
PERSONALITY OVERRIDE — AGGRESSIVE EDGE-CASE TESTING:
- Your goal is to BREAK the application. Think like a destructive tester.
- For every input field, test: empty string, whitespace only, max+1 length, Unicode emojis (🎉🔥),
  HTML injection (<script>alert(1)</script>), SQL fragments ('; DROP TABLE--), null bytes,
  extremely long strings (10,000+ chars), negative numbers, zero, MAX_INT, special chars (!@#$%^&*).
- For every form: submit with all fields empty, submit with only required fields, double-submit
  (click submit twice rapidly), submit then immediately navigate away.
- For every dropdown: test first option, last option, and try to inject a non-existent option value.
- For every date field: test past dates, future dates, invalid dates (Feb 30), epoch zero.
- For file uploads: try uploading wrong MIME type, 0-byte file, very large file, file with special chars in name.
- Test concurrent operations: open same form in two tabs, submit both.
- Always verify error handling: does the app show a user-friendly message or crash?`,
    emphasisAreas: ['boundary-values', 'special-characters', 'injection', 'concurrent', 'error-handling'],
    maxTestsPerFlow: 20,
  },

  security_focused: {
    id: 'security_focused',
    name: 'Security-Focused Tester',
    description: 'OWASP-inspired testing — injection, XSS, CSRF, auth bypass, privilege escalation.',
    temperature: 0.5,
    testTypeWeights: { positive: 0.1, negative: 0.6, edge: 0.3 },
    systemPromptOverlay: `
PERSONALITY OVERRIDE — SECURITY TESTING (OWASP-aligned):
- Test for XSS: inject <script>alert('xss')</script>, <img onerror=alert(1)>, javascript: URLs in input fields.
  Verify the application either sanitizes the input or shows an error — never renders it as HTML.
- Test for injection: try SQL fragments ('; DROP TABLE users--), NoSQL ($gt, $ne),
  LDAP injection (*)(objectClass=*), command injection (; ls -la), path traversal (../../etc/passwd).
- Test authorization: if the app has different roles, verify lower-privilege users cannot access
  higher-privilege endpoints by manipulating URLs or form data.
- Test authentication: verify session expiry behavior, test with expired/invalid tokens,
  verify logout actually invalidates the session.
- Test IDOR: if URLs contain IDs (/user/123/profile), test accessing other users' resources by changing the ID.
- Test rate limiting: attempt rapid-fire form submissions — does the server throttle?
- Test file uploads: upload files with executable extensions (.php, .exe), polyglot files,
  oversized files, files with null bytes in names.
- For every input: verify the output is properly encoded (no raw HTML rendering of user input).`,
    emphasisAreas: ['xss', 'injection', 'authorization', 'authentication', 'idor', 'rate-limiting'],
    maxTestsPerFlow: 15,
  },

  accessibility_first: {
    id: 'accessibility_first',
    name: 'Accessibility-First Tester',
    description: 'Tests keyboard navigation, screen reader compatibility, focus management, and ARIA correctness.',
    temperature: 0.3,
    testTypeWeights: { positive: 0.4, negative: 0.3, edge: 0.3 },
    systemPromptOverlay: `
PERSONALITY OVERRIDE — ACCESSIBILITY TESTING:
- For every interactive element: verify it can be reached and activated via keyboard alone (Tab + Enter/Space).
- For every form: complete the entire flow using only keyboard navigation. Verify focus order is logical.
- After form submission: verify focus moves to the result message (success or error).
- For modals/dialogs: verify focus is trapped inside the modal, Escape closes it, and focus returns to the trigger.
- For every error state: verify the error is announced to screen readers (role="alert" or aria-live).
- For dropdown menus: verify arrow key navigation works, Escape closes the menu.
- For dynamic content: verify newly appearing content is announced (aria-live region).
- Test with screen reader assertions: verify elements have meaningful accessible names.
- Verify all images have alt text, all form fields have labels, all headings have proper hierarchy.`,
    emphasisAreas: ['keyboard-nav', 'focus-management', 'screen-reader', 'aria', 'heading-hierarchy'],
    maxTestsPerFlow: 12,
  },

  performance_minded: {
    id: 'performance_minded',
    name: 'Performance-Minded Tester',
    description: 'Tests behavior under load and with large data sets. Pagination, lazy loading, debouncing.',
    temperature: 0.4,
    testTypeWeights: { positive: 0.3, negative: 0.3, edge: 0.4 },
    systemPromptOverlay: `
PERSONALITY OVERRIDE — PERFORMANCE TESTING:
- For lists/tables with pagination: navigate to the last page, verify data loads correctly.
- For search/filter: type rapidly and verify debouncing works (no stale results displayed).
- For forms with many fields: fill all fields and measure if submission is responsive.
- For file uploads: test with the maximum allowed file size.
- For infinite scroll: scroll to load 100+ items and verify the page remains responsive.
- For bulk operations: select all items and perform a bulk action.
- Test with slow network simulation in mind: what happens if the user clicks Submit and
  the response takes 10 seconds? Is there a loading indicator? Can they double-submit?
- For real-time features: verify WebSocket reconnection after brief disconnection.`,
    emphasisAreas: ['pagination', 'lazy-loading', 'debouncing', 'bulk-operations', 'loading-states'],
    maxTestsPerFlow: 12,
  },
};

/**
 * Get a personality by ID. Returns 'balanced' as default for unknown IDs.
 */
export function getPersonality(id: TestPersonalityId): TestPersonality {
  if (id === 'custom') {
    return PERSONALITIES.balanced; // custom handled separately
  }
  return PERSONALITIES[id] ?? PERSONALITIES.balanced;
}

/**
 * Create a custom personality from a free-text description.
 * Converts the user's description into a structured systemPromptOverlay.
 */
export function createCustomPersonality(description: string): TestPersonality {
  return {
    id: 'custom',
    name: 'Custom',
    description: description.slice(0, 200),
    temperature: 0.5,
    testTypeWeights: { positive: 0.25, negative: 0.4, edge: 0.35 },
    systemPromptOverlay: `
PERSONALITY OVERRIDE — CUSTOM TESTER INSTRUCTIONS:
${description}

Apply these instructions to every test you generate. Prioritize the areas described above.`,
    emphasisAreas: [],
    maxTestsPerFlow: 15,
  };
}

/**
 * Augment a system prompt with personality-specific instructions.
 */
export function applyPersonalityToPrompt(
  baseSystemPrompt: string,
  personality: TestPersonality
): string {
  if (!personality.systemPromptOverlay) return baseSystemPrompt;
  return `${baseSystemPrompt}\n\n${personality.systemPromptOverlay}`;
}

/**
 * Get all available personality options for the UI.
 */
export function listPersonalities(): Array<{ id: TestPersonalityId; name: string; description: string }> {
  return Object.values(PERSONALITIES).map(({ id, name, description }) => ({ id, name, description }));
}
