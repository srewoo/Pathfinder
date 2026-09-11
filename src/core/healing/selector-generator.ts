import type { AIClientInterface } from '../ai/ai-client';
import { PROMPTS } from '../ai/prompt-templates';
import { sendToContentScript } from '../../messaging/messenger';
import { createLogger } from '../../utils/logger';
import { isHashOnlySelector } from './class-stability';

const log = createLogger('selector-gen');

export async function generateAlternativeSelectors(
  failingSelector: string,
  description: string,
  tabId: number,
  aiClient: AIClientInterface
): Promise<string[]> {
  const domContext = await getDOMContext(tabId);

  const prompt = PROMPTS.selectorHealing;

  let raw: string;
  try {
    raw = await aiClient.chat(
      [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user(failingSelector, description, domContext) },
      ],
      { temperature: 0.2, jsonMode: true }
    );
  } catch (err) {
    log.warn('AI selector generation failed', err);
    return [];
  }

  return parseAlternatives(raw);
}

/**
 * Compressed DOM of the page, as context for a healing model.
 *
 * Exported because the visual healing tier needs the same context — a selector
 * proposed from a screenshot must still exist in the DOM.
 */
export async function getDOMContext(tabId: number): Promise<string> {
  try {
    const response = await sendToContentScript<{ payload: { domCompressed: string } }>(tabId, {
      type: 'GET_DOM_SNAPSHOT',
    });
    return response?.payload?.domCompressed ?? '';
  } catch {
    return '';
  }
}

/**
 * Parse the model's selector list.
 *
 * Hash-only candidates are dropped here rather than at the use sites: the model
 * is told not to produce them, and when it does anyway there is no point
 * carrying a selector one layer further that is guaranteed to break on the next
 * build.
 */
export function parseAlternatives(raw: string): string[] {
  try {
    const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
    const json = JSON.parse(cleaned) as Record<string, unknown>;

    if (Array.isArray(json['alternatives'])) {
      return json['alternatives']
        .map(String)
        .filter((s) => s.length > 0)
        .filter((s) => !isHashOnlySelector(s));
    }
  } catch {
    log.warn('Failed to parse selector alternatives');
  }
  return [];
}
