import { sendToContentScript } from '../../messaging/messenger';
import type { InteractiveElement } from '../../storage/schemas';

/** Minimum Jaccard similarity score for a candidate to be considered a match.
 * Raised from 0.35 to 0.55 to reduce false-positive healing matches. */
const SIMILARITY_THRESHOLD = 0.55;

/**
 * Find elements in the live DOM that are semantically similar to a failing
 * selector + description pair. Returns CSS selectors sorted by similarity.
 */
export async function findSimilarElements(
  selector: string,
  description: string,
  tabId: number
): Promise<string[]> {
  try {
    const response = await sendToContentScript<{ payload: InteractiveElement[] }>(tabId, {
      type: 'GET_ELEMENTS',
    });

    const elements = response?.payload ?? [];
    if (elements.length === 0) return [];

    // Build the target word set from both the description and the original selector
    const targetWords = extractWords(description + ' ' + selector);

    // Extract the expected tag/type from the selector if we can (e.g. 'button', 'input')
    const expectedTag = inferTagFromSelector(selector);

    const scored = elements
      .map((el) => {
        const elText = extractWords(
          `${el.text ?? ''} ${el.ariaLabel ?? ''} ${el.tag} ${el.type ?? ''} ${el.role ?? ''} ${el.name ?? ''} ${el.testId ?? ''} ${(el.classes ?? []).join(' ')}`
        );
        let score = jaccardSimilarity(targetWords, elText);

        // Boost score when the tag matches (a button selector should prefer buttons)
        if (expectedTag && el.tag === expectedTag) score += 0.15;

        // Boost visible elements
        if (el.visible) score += 0.05;

        return { el, score };
      })
      .filter((s) => s.score >= SIMILARITY_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    return scored.map((s) => s.el.selector);
  } catch {
    return [];
  }
}

function inferTagFromSelector(selector: string): string | null {
  // Try: tag at start (e.g. "button.class"), tag alone, or tag after "]" (e.g. "[data-testid]button")
  const match = selector.match(/^([a-z]+)[\[#.:]/i)
    ?? selector.match(/^([a-z]+)$/i)
    ?? selector.match(/\]([a-z]+)/i);
  return match ? match[1].toLowerCase() : null;
}

function extractWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  const intersection = new Set([...a].filter((x) => b.has(x)));
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 0;
  return intersection.size / union.size;
}
