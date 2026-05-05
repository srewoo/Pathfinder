/**
 * AI-Guided Exploration Agent (Chrome Extension)
 *
 * Instead of clicking every visible button on a page, this module asks the AI
 * to look at the interactive elements and rank which ones are most likely to
 * reveal NEW functionality — forms, modals, navigation paths, settings panels, etc.
 *
 * The AI returns a prioritised list (up to MAX_AI_ACTIONS). The explorer clicks
 * only those, in priority order, dramatically improving signal-to-noise.
 * One AI call per page.
 */

import type { AIClientInterface } from '../ai/ai-client';
import type { InteractiveElement } from '../../storage/schemas';
import { PROMPTS } from '../ai/prompt-templates';
import { createLogger } from '../../utils/logger';

const log = createLogger('agent-explorer');
const MAX_AI_ACTIONS = 20;

export interface AgentAction {
  selector: string;
  action: 'click';
  description: string;
  expectedOutcome: 'new_page' | 'modal' | 'dropdown' | 'form' | 'unknown';
  priority: number;
}

/**
 * Ask the AI which interactive elements on the current page are worth clicking
 * to discover new functionality. Returns a priority-sorted list (highest first).
 *
 * @param currentUrl       - URL of the page being explored.
 * @param title            - Page title.
 * @param elements         - Visible interactive elements from scanPage().
 * @param discoveredUrls   - Pages already found (AI avoids re-navigating to these).
 * @param exploredSelectors - Selectors already clicked on this page (AI skips these).
 * @param aiClient         - AI client for the ranking call.
 */
export async function getAgentActions(
  currentUrl: string,
  title: string,
  elements: InteractiveElement[],
  discoveredUrls: Set<string>,
  exploredSelectors: Set<string>,
  aiClient: AIClientInterface
): Promise<AgentAction[]> {
  // Filter to clickable, visible, unexplored candidates
  const candidates = elements.filter((el) => {
    if (!el.visible) return false;
    if (exploredSelectors.has(el.selector)) return false;
    const isClickable =
      el.tag === 'button' ||
      el.tag === 'a' ||
      el.role === 'button' ||
      el.role === 'tab' ||
      el.role === 'menuitem' ||
      el.role === 'option';
    return isClickable;
  });

  if (candidates.length === 0) return [];

  const elementList = candidates
    .slice(0, 100) // stay within token budget
    .map((el, i) => {
      const label = el.ariaLabel || el.text || '';
      const testId = el.testId ? ` data-testid="${el.testId}"` : '';
      return `${i + 1}. selector="${el.selector}"${testId} text="${label.slice(0, 60)}" tag=${el.tag}`;
    })
    .join('\n');

  const knownUrlsList = [...discoveredUrls].slice(0, 50).join('\n') || '(none yet)';

  const prompt = PROMPTS.explorationGuidance;
  let raw: string;
  try {
    raw = await aiClient.chat(
      [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user(currentUrl, title, elementList, knownUrlsList) },
      ],
      { temperature: 0.1, jsonMode: true, maxTokens: 4500 }
    );
  } catch (err) {
    log.warn(`Agent explorer AI call failed for ${currentUrl}: ${err}`);
    return [];
  }

  try {
    const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
    const parsed = JSON.parse(cleaned) as { actions?: AgentAction[] };
    const actions = (parsed.actions ?? [])
      .filter((a) => typeof a.selector === 'string' && a.selector.length > 0)
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
      .slice(0, MAX_AI_ACTIONS);
    log.info(`Agent explorer: ${actions.length} actions ranked for "${title || currentUrl}"`);
    return actions;
  } catch (err) {
    log.warn(`Agent explorer failed to parse AI response: ${String(err).slice(0, 120)}`);
    return [];
  }
}
