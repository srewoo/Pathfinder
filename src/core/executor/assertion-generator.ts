/**
 * AI-Generated Assertion Builder
 *
 * After key execution steps (navigate, click, type, select), captures the live
 * DOM state and asks the AI to suggest a targeted assertion verifying the
 * observed outcome. Only triggers on action types that typically change
 * visible state. One lightweight AI call per qualifying step.
 */

import type { AIClientInterface } from '../ai/ai-client';
import type { ExecutionStep, AssertType } from '../../storage/schemas';
import { getPageSnapshot } from '../explorer/page-scanner';
import { createLogger } from '../../utils/logger';

const log = createLogger('assertion-generator');

/** Actions where auto-assertions add value by checking state change. */
const ASSERTION_TRIGGER_ACTIONS = new Set<string>([
  'navigate', 'click', 'select', 'check', 'uncheck',
]);

export interface GeneratedAssertion {
  selector?: string;
  assertType: AssertType;
  assertExpected?: string;
  description: string;
}

/**
 * After executing a step, capture current DOM and ask the AI to generate a
 * precise assertion for the observed state change.
 *
 * Returns null when:
 * - The action type doesn't warrant a DOM assertion
 * - The page didn't change meaningfully
 * - The AI call fails
 */
export async function generatePostStepAssertion(
  tabId: number,
  step: ExecutionStep,
  previousUrl: string,
  aiClient: AIClientInterface
): Promise<GeneratedAssertion | null> {
  if (!ASSERTION_TRIGGER_ACTIONS.has(step.action)) return null;

  const snapshot = await getPageSnapshot(tabId).catch(() => null);
  if (!snapshot) return null;

  const currentUrl = snapshot.url;
  const urlChanged = currentUrl !== previousUrl;

  // Build concise visible element list for context
  const visibleElements = snapshot.elements
    .filter((el) => el.visible && (el.text || el.ariaLabel))
    .slice(0, 20)
    .map((el) => {
      const label = (el.text || el.ariaLabel || '').slice(0, 60);
      const id = el.testId ? ` [data-testid="${el.testId}"]` : '';
      return `${el.tag}${id}: "${label}"`;
    })
    .join('\n');

  const context = [
    `Action: [${step.action}] ${step.description}`,
    urlChanged
      ? `URL changed: ${previousUrl} → ${currentUrl}`
      : `URL unchanged: ${currentUrl}`,
    `Page title: "${snapshot.title}"`,
    `Visible elements:\n${visibleElements || '(none visible)'}`,
  ].join('\n');

  let raw: string;
  try {
    raw = await aiClient.chat(
      [{
        role: 'user',
        content: `${context}

Generate ONE specific assertion that verifies the expected outcome of this action.
Pick the most useful assertType from: visible, not_visible, text, url, exists, not_exists.
For "text" assertType, assertExpected should be the exact visible text to check.
For "url" assertType, assertExpected should be the URL or partial URL.
Return JSON only: {"selector": "css-or-null", "assertType": "...", "assertExpected": "value-or-null", "description": "what this checks"}`,
      }],
      { temperature: 0, jsonMode: true, maxTokens: 200 }
    );
  } catch (err) {
    log.debug(`Assertion generation failed for step ${step.order}: ${err}`);
    return null;
  }

  try {
    const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;

    const assertType = parsed['assertType'] as AssertType;
    const validTypes: AssertType[] = [
      'visible', 'not_visible', 'text', 'not_text', 'url',
      'exists', 'not_exists', 'enabled', 'disabled', 'value',
    ];
    if (!validTypes.includes(assertType)) return null;

    const assertion: GeneratedAssertion = {
      selector: typeof parsed['selector'] === 'string' && parsed['selector'] !== 'null'
        ? parsed['selector']
        : undefined,
      assertType,
      assertExpected: typeof parsed['assertExpected'] === 'string' && parsed['assertExpected'] !== 'null'
        ? parsed['assertExpected']
        : undefined,
      description: typeof parsed['description'] === 'string'
        ? parsed['description']
        : `Verify state after: ${step.description}`,
    };

    log.debug(`Step ${step.order} → auto-assertion: [${assertion.assertType}] ${assertion.description}`);
    return assertion;
  } catch {
    return null;
  }
}

/** Convert a GeneratedAssertion into an ExecutionStep that can be run immediately. */
export function assertionToStep(assertion: GeneratedAssertion, order: number): ExecutionStep {
  return {
    order,
    action: 'assert',
    selector: assertion.selector,
    assertType: assertion.assertType,
    assertExpected: assertion.assertExpected,
    description: `[Auto] ${assertion.description}`,
  };
}
