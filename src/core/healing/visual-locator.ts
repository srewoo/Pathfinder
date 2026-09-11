/**
 * Vision tier of self-healing.
 *
 * The three DOM strategies all reason over text: alternative selectors from the
 * model, Jaccard text similarity, and attribute derivation. None can resolve a
 * control whose identity is purely visual — an icon-only button, a
 * canvas-rendered widget, or two DOM-identical rows a user tells apart only by
 * position on screen.
 *
 * The executor already holds a screenshot from the exact moment of failure. This
 * tier is the only consumer that can use it, and it runs LAST because it is the
 * most expensive: a vision call costs several times a text call, so it is only
 * paid once the cheap tiers have all declined.
 */
import type { AIClientInterface } from '../ai/ai-client';
import { PROMPTS } from '../ai/prompt-templates';
import { isHashOnlySelector } from './class-stability';
import { createLogger } from '../../utils/logger';

const log = createLogger('visual-locator');

/** Beyond three, validating candidates costs more than the healing is worth. */
const MAX_CANDIDATES = 3;

export interface VisualHealArgs {
  /** The step's human-readable intent — what the test was trying to do. */
  description: string;
  /** The selector that failed, as a negative example. */
  failedSelector: string;
  error: string;
  /** Base64 PNG, with or without a data-URI prefix. */
  screenshot?: string;
  /** Compressed DOM of the failing page, so proposed selectors actually exist. */
  domContext: string;
  aiClient: AIClientInterface;
}

/** Strip a data-URI prefix; providers want raw base64. */
function rawBase64(image: string): string {
  return image.replace(/^data:image\/[a-z+]+;base64,/i, '');
}

/**
 * Parse a selector array out of a model reply, tolerating code fences.
 *
 * Returns `[]` rather than throwing on anything unexpected: a healer that
 * crashes turns a recoverable step failure into a lost run.
 */
function parseCandidates(raw: string): string[] {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const body = fenced ? fenced[1] : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.trim());
  } catch {
    return [];
  }
  // Accept both a bare array and `{ "selectors": [...] }` — models drift
  // between the two and either is unambiguous.
  const list = Array.isArray(parsed)
    ? parsed
    : ((parsed as { selectors?: unknown } | null)?.selectors ?? null);
  if (!Array.isArray(list)) return [];
  return list
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .map((s) => s.trim());
}

export async function proposeSelectorFromScreenshot(args: VisualHealArgs): Promise<string[]> {
  // No image, no vision tier. Never pay for a call that cannot use its input.
  if (!args.screenshot) return [];

  const prompt = PROMPTS.visualHealing;
  let raw: string;
  try {
    raw = await args.aiClient.chat(
      [
        { role: 'system', content: prompt.system },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: prompt.user(args.description, args.failedSelector, args.error, args.domContext),
            },
            { type: 'image', data: rawBase64(args.screenshot), mimeType: 'image/png' },
          ],
        },
      ],
      { temperature: 0, maxTokens: 300 }
    );
  } catch (err) {
    log.warn('Vision healing call failed', err);
    return [];
  }

  return parseCandidates(raw)
    .filter((s) => !isHashOnlySelector(s))
    .slice(0, MAX_CANDIDATES);
}
