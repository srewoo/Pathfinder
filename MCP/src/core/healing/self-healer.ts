import type { Page } from 'playwright';
import type { ExecutionStep, HealingAttempt, InteractiveElement } from '../../storage/schemas.js';
import type { AIClientInterface } from '../ai/ai-client.js';
import { executeStepOnPage, getPageSnapshotFromPage, screenshotPage, getAccessibilitySnapshot } from '../../browser/playwright-adapter.js';
import { PROMPTS } from '../ai/prompt-templates.js';
import { lookupHealedSelector, recordSuccessfulHeal, recordHealFailure } from '../../memory/selector-memory.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('self-healer');
const MAX_CANDIDATES = 3;

export interface HealingResult {
  success: boolean;
  healedStep?: ExecutionStep;
  attempt: HealingAttempt;
}

export async function healStep(
  page: Page,
  step: ExecutionStep,
  error: string,
  aiClient: AIClientInterface
): Promise<HealingResult> {
  const originalSelector = step.selector ?? '';
  const pageUrl = page.url();

  // Strategy 0: Check memory for known heal
  try {
    const remembered = await lookupHealedSelector(pageUrl, originalSelector);
    if (remembered) {
      log.info(`Memory hit: trying known heal ${originalSelector} → ${remembered.healedSelector}`);
      const healedStep = { ...step, selector: remembered.healedSelector };
      const result = await executeStepOnPage(page, healedStep);
      if (result.status === 'passed') {
        await recordSuccessfulHeal(pageUrl, originalSelector, remembered.healedSelector, remembered.method);
        return makeResult(true, healedStep, step.order, originalSelector, remembered.method as HealingAttempt['method'], remembered.healedSelector);
      }
      // Memory was stale — continue to regular strategies
      log.info(`Memory heal stale for ${originalSelector}, trying fresh strategies`);
    }
  } catch (err) {
    log.debug('Memory lookup failed, continuing with strategies', err);
  }

  // Strategy 1: DOM similarity
  log.info(`Strategy 1 (DOM similarity) for: ${originalSelector}`);
  let snapshot: Awaited<ReturnType<typeof getPageSnapshotFromPage>>;
  try {
    snapshot = await getPageSnapshotFromPage(page);
  } catch (err) {
    // If snapshotting fails (DOM/script errors, frame traversal issues),
    // treat healing as failed rather than crashing the whole test.
    log.warn('Snapshot collection failed during healing', err);
    return makeResult(false, undefined, step.order, originalSelector, 'ai', error);
  }
  const targetWords = extractWords(step.description + ' ' + originalSelector);
  const similar = snapshot.elements
    .map((el) => ({
      el,
      score: jaccardSimilarity(
        targetWords,
        extractWords(`${el.text ?? ''} ${el.ariaLabel ?? ''} ${el.tag} ${el.type ?? ''} ${el.role ?? ''} ${el.name ?? ''}`)
      ),
    }))
    .filter((s) => s.score >= 0.35)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES);

  for (const { el } of similar) {
    const healedStep = { ...step, selector: el.selector };
    const result = await executeStepOnPage(page, healedStep);
    if (result.status === 'passed') {
      try { await recordSuccessfulHeal(pageUrl, originalSelector, el.selector, 'similarity'); } catch {}
      return makeResult(true, healedStep, step.order, originalSelector, 'similarity', el.selector);
    }
  }

  // Strategy 2: Attribute selectors
  log.info(`Strategy 2 (attribute selectors) for: ${originalSelector}`);
  const attrCandidates = deriveAttributeSelectors(snapshot.elements, step.description);
  for (const selector of attrCandidates.slice(0, MAX_CANDIDATES)) {
    const healedStep = { ...step, selector };
    const result = await executeStepOnPage(page, healedStep);
    if (result.status === 'passed') {
      try { await recordSuccessfulHeal(pageUrl, originalSelector, selector, 'alternative'); } catch {}
      return makeResult(true, healedStep, step.order, originalSelector, 'alternative', selector);
    }
  }

  // Strategy 3: AI regeneration
  log.info(`Strategy 3 (AI) for: ${originalSelector}`);
  try {
    const prompt = PROMPTS.selectorHealing;
    const raw = await aiClient.chat(
      [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user(originalSelector, step.description, snapshot.domCompressed) },
      ],
      { temperature: 0.2, jsonMode: true }
    );
    const parsed = JSON.parse(raw.replace(/```json\n?|\n?```/g, '').trim());
    const alternatives = Array.isArray(parsed.alternatives) ? parsed.alternatives.map(String) : [];
    for (const selector of alternatives.slice(0, MAX_CANDIDATES)) {
      const healedStep = { ...step, selector };
      const result = await executeStepOnPage(page, healedStep);
      if (result.status === 'passed') {
        try { await recordSuccessfulHeal(pageUrl, originalSelector, selector, 'ai'); } catch {}
        return makeResult(true, healedStep, step.order, originalSelector, 'ai', selector);
      }
    }
  } catch (err) {
    log.warn('AI healing failed', err);
  }

  // Strategy 4: Vision-based healing — screenshot + Claude vision
  // This is the last resort before giving up. Claude can see the rendered page
  // and identify the correct element even when the DOM is opaque (custom components,
  // shadow DOM, dynamically generated classes).
  log.info(`Strategy 4 (vision) for: ${originalSelector}`);
  if (PROMPTS.visionHealing) {
    try {
      const [screenshotBase64, a11yTree] = await Promise.all([
        screenshotPage(page, false),
        getAccessibilitySnapshot(page),
      ]);
      const visionPrompt = PROMPTS.visionHealing;
      const raw = await aiClient.chat(
        [
          { role: 'system', content: visionPrompt.system },
          {
            role: 'user',
            content: [
              { type: 'image', data: screenshotBase64, mimeType: 'image/png' },
              { type: 'text', text: visionPrompt.user(originalSelector, step.description, a11yTree) },
            ],
          },
        ],
        { temperature: 0.2, jsonMode: true, maxTokens: 1024 }
      );
      const parsed = JSON.parse(raw.replace(/```json\n?|\n?```/g, '').trim());
      const alternatives = Array.isArray(parsed.alternatives) ? parsed.alternatives.map(String) : [];
      for (const selector of alternatives.slice(0, MAX_CANDIDATES)) {
        const healedStep = { ...step, selector };
        const result = await executeStepOnPage(page, healedStep);
        if (result.status === 'passed') {
          try { await recordSuccessfulHeal(pageUrl, originalSelector, selector, 'ai'); } catch {}
          return makeResult(true, healedStep, step.order, originalSelector, 'ai', selector);
        }
      }
    } catch (err) {
      log.warn('Vision healing failed', err);
    }
  }

  // All strategies failed — record to memory
  try { await recordHealFailure(pageUrl, originalSelector); } catch {}

  return makeResult(false, undefined, step.order, originalSelector, 'ai', undefined, error);
}

function makeResult(
  success: boolean,
  healedStep: ExecutionStep | undefined,
  stepOrder: number,
  originalSelector: string,
  method: HealingAttempt['method'],
  healedSelector?: string,
  error?: string
): HealingResult {
  return {
    success,
    healedStep,
    attempt: {
      stepOrder,
      originalSelector,
      method,
      healedSelector,
      success,
      error,
    },
  };
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
  return union.size === 0 ? 0 : intersection.size / union.size;
}

function deriveAttributeSelectors(elements: InteractiveElement[], description: string): string[] {
  const keywords = new Set(
    description
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1)
  );
  const candidates: { selector: string; score: number }[] = [];
  for (const el of elements) {
    const score = [el.text, el.ariaLabel, el.role, el.tag, el.type]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => keywords.has(w)).length;
    if (score > 0) {
      if (el.testId) candidates.push({ selector: `[data-testid="${el.testId}"]`, score: score + 2 });
      if (el.ariaLabel) candidates.push({ selector: `[aria-label="${el.ariaLabel}"]`, score: score + 1 });
      if (el.name) candidates.push({ selector: `${el.tag}[name="${el.name}"]`, score: score + 1 });
      candidates.push({ selector: el.selector, score });
    }
  }
  return [...new Set(candidates.sort((a, b) => b.score - a.score).map((c) => c.selector))].slice(0, 5);
}
