import { sendToContentScript } from '../../messaging/messenger';
import type { InteractiveElement } from '../../storage/schemas';

/**
 * Generate a ranked list of valid CSS selectors for the element described
 * by `description` by inspecting the live DOM via the content script.
 *
 * This strategy differs from DOM similarity in that it builds concrete,
 * attribute-targeted selectors from the live elements rather than relying
 * on Jaccard text matching alone.
 */
export async function buildAttributeSelectors(
  description: string,
  tabId: number
): Promise<string[]> {
  let elements: InteractiveElement[] = [];

  try {
    const response = await sendToContentScript<{ payload: InteractiveElement[] }>(tabId, {
      type: 'GET_ELEMENTS',
    });
    elements = response?.payload ?? [];
  } catch {
    return [];
  }

  if (elements.length === 0) return [];

  const keywords = tokenise(description);
  const candidates: { selector: string; score: number }[] = [];

  for (const el of elements) {
    const selectors = deriveSelectors(el);
    const score = scoreElement(el, keywords);
    if (score > 0) {
      for (const selector of selectors) {
        candidates.push({ selector, score });
      }
    }
  }

  // Return unique selectors sorted by score
  const seen = new Set<string>();
  return candidates
    .sort((a, b) => b.score - a.score)
    .map((c) => c.selector)
    .filter((s) => {
      if (seen.has(s)) return false;
      seen.add(s);
      return true;
    })
    .slice(0, 5);
}

function deriveSelectors(el: InteractiveElement): string[] {
  const selectors: string[] = [];

  // Most reliable — use the selector the detector already computed
  if (el.selector) selectors.push(el.selector);

  // data-testid based (highest priority for stability)
  if (el.testId) {
    selectors.push(`[data-testid="${el.testId}"]`);
    selectors.push(`${el.tag}[data-testid="${el.testId}"]`);
  }

  // Aria-label based
  if (el.ariaLabel) {
    selectors.push(`[aria-label="${el.ariaLabel}"]`);
    selectors.push(`${el.tag}[aria-label="${el.ariaLabel}"]`);
  }

  // Name based (for form fields)
  if (el.name) {
    selectors.push(`${el.tag}[name="${el.name}"]`);
  }

  // Role based
  if (el.role) {
    selectors.push(`[role="${el.role}"]`);
    selectors.push(`${el.tag}[role="${el.role}"]`);
  }

  // Class-based selectors (stable classes only)
  if (el.classes && el.classes.length > 0) {
    // Use the most specific class selector
    const classSelector = `${el.tag}.${el.classes.join('.')}`;
    selectors.push(classSelector);
    // Also try individual significant classes
    for (const cls of el.classes.slice(0, 2)) {
      selectors.push(`${el.tag}.${cls}`);
    }
  }

  return selectors.filter(Boolean);
}

function scoreElement(el: InteractiveElement, keywords: Set<string>): number {
  const fields = [
    el.text ?? '',
    el.ariaLabel ?? '',
    el.role ?? '',
    el.tag,
    el.type ?? '',
  ].join(' ').toLowerCase();

  const fieldTokens = tokenise(fields);
  let score = 0;
  for (const kw of keywords) {
    if (fieldTokens.has(kw)) score++;
  }
  return score;
}

function tokenise(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1)
  );
}
