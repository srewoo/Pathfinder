/**
 * Doc-grounded oracles: does the observed state change match what the docs
 * promised?
 *
 * This is the piece that turns "a success banner appeared" into "the docs say
 * saving an order issues POST /api/orders and shows the order number — it showed
 * the number but never called the endpoint".
 *
 * The knowledge base is already RAG-indexed and already feeds planning; it was
 * never consulted at ASSERTION time, which is where a documented expectation is
 * worth the most.
 *
 * Boundaries this respects (§6, §8.0, §9):
 *
 *   - The model NEVER decides pass/fail. It converts prose expectations into
 *     `Assertion` objects, which are validated and then evaluated
 *     deterministically. A hallucinated expectation becomes a parse error, not a
 *     verdict.
 *   - It runs at GENERATION time, outside the executor.
 *   - It only speaks when the docs actually say something. No retrieval hit means
 *     no assertion — inventing an expectation is how a doc-grounded oracle turns
 *     into a confident false positive.
 */
import type { AIClientInterface } from '../ai/ai-client';
import type { Assertion } from '../ir/test-ir';
import { AssertionSchema } from '../ir/test-ir';
import type { StateDiff } from '../analysis/state-diff';
import { describeDiff } from '../analysis/state-diff';
import { searchByText } from '../knowledge/vector-search';
import { parseJSON } from '../ai/validators';
import { createLogger } from '../../utils/logger';

const log = createLogger('doc-grounded-oracle');

/** Below this retrieval score the docs are not really about this action. */
const MIN_DOC_SCORE = 0.35;
const TOP_K = 4;

/**
 * Shape guard for the model's reply.
 *
 * Only checks the envelope; each assertion is validated individually against the
 * IR schema afterwards, so one malformed entry cannot discard the rest.
 */
function isAssertionsShape(value: unknown): value is { assertions: unknown[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { assertions?: unknown }).assertions)
  );
}

export interface DocExpectation {
  /** The documented text the expectation came from. */
  source: string;
  sourceUrl: string;
  /** Doc title, so a citation reads as a place rather than a URL. */
  sourceTitle: string;
  score: number;
}

export interface GroundedOracleResult {
  /** Assertions to add to the test, already validated. */
  assertions: Assertion[];
  /** Docs the assertions were derived from — the audit trail. */
  expectations: DocExpectation[];
  /** Why nothing was produced, when `assertions` is empty. */
  skipped?: string;
}

/**
 * Retrieve what the documentation says about an action.
 *
 * Returns an empty list rather than a low-relevance guess: a weak match produces
 * assertions about a different feature, which is worse than none.
 */
export async function retrieveExpectations(
  actionDescription: string,
  pageUrl: string,
  aiClient: AIClientInterface
): Promise<DocExpectation[]> {
  try {
    const results = await searchByText(
      `${actionDescription} expected behaviour outcome ${pageUrl}`,
      (texts) => aiClient.embed(texts),
      TOP_K
    );
    return results
      .filter((r) => r.score >= MIN_DOC_SCORE)
      .map((r) => ({
        source: r.record.content,
        sourceUrl: r.record.url,
        sourceTitle: r.record.metadata?.title ?? '',
        score: r.score,
      }));
  } catch (err) {
    log.debug('Doc retrieval failed', err);
    return [];
  }
}

const SYSTEM_PROMPT = `You convert product documentation into test assertions.

You are given:
  1. An action a user performed.
  2. Documentation describing what that action is supposed to do.
  3. The state changes ACTUALLY observed on four channels (URL, DOM messages, network, client storage).

Your job is to emit assertions that check the DOCUMENTED behaviour — not to judge
whether the observation was correct. A separate deterministic engine evaluates
your assertions.

RULES:
- Only assert what the documentation explicitly states. Never infer.
- If the documentation says nothing checkable about this action, return {"assertions": []}.
- Prefer assertions about durable, meaningful outcomes (a request was made, a value
  is shown, the URL changed) over cosmetic ones (an element exists).
- Use "api_called" or "api_status" when the docs mention an endpoint or a save.
- Use "text" with the exact documented wording when the docs quote a message.
- Never assert on a password or token value.

Return JSON only:
{"assertions":[{"kind":"<kind>","expected":"<string>","description":"<why the docs require this>"}]}

Valid kinds: visible, not_visible, exists, not_exists, text, not_text, value,
attribute, enabled, disabled, count, exact_count, url, api_called,
api_not_called, api_status`;

/**
 * Derive assertions for an observed action from the documentation.
 *
 * The diff is included in the prompt so the model can pick assertion KINDS that
 * are actually checkable on this page — not so it can decide whether the diff was
 * acceptable. That distinction is the whole design: the model shapes the question,
 * the engine gives the answer.
 */
export async function deriveDocGroundedAssertions(
  input: {
    actionDescription: string;
    pageUrl: string;
    diff: StateDiff;
    /** Order the assertions attach to, so they check intermediate state (§6). */
    afterStep?: number;
    startOrder?: number;
  },
  aiClient: AIClientInterface
): Promise<GroundedOracleResult> {
  const expectations = await retrieveExpectations(
    input.actionDescription,
    input.pageUrl,
    aiClient
  );

  if (expectations.length === 0) {
    // The single most important guard: no docs, no assertions. Inventing an
    // expectation here is how this feature would become a false-positive engine.
    return {
      assertions: [],
      expectations: [],
      skipped: 'no documentation matched this action above the relevance threshold',
    };
  }

  const docContext = expectations
    .map((e, i) => `[doc ${i + 1}] (${e.sourceUrl})\n${e.source.slice(0, 1200)}`)
    .join('\n\n');

  let raw: string;
  try {
    raw = await aiClient.chat(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content:
            `ACTION: ${input.actionDescription}\n` +
            `PAGE: ${input.pageUrl}\n\n` +
            `DOCUMENTATION:\n${docContext}\n\n` +
            `OBSERVED STATE CHANGES:\n${describeDiff(input.diff)}`,
        },
      ],
      { temperature: 0, jsonMode: true, maxTokens: 700 }
    );
  } catch (err) {
    log.warn('Doc-grounded assertion generation failed', err);
    return { assertions: [], expectations, skipped: 'AI call failed' };
  }

  const parsed = parseJSON(raw, isAssertionsShape);
  if (!parsed.ok) {
    log.debug(`Doc-grounded oracle returned unusable JSON: ${parsed.error}`);
    return { assertions: [], expectations, skipped: 'model returned unparseable JSON' };
  }

  // Every assertion goes through the IR schema. An unusable one is dropped with a
  // log line rather than silently coerced into something that would pass.
  const assertions: Assertion[] = [];
  let order = input.startOrder ?? 0;

  for (const candidate of parsed.value.assertions) {
    const withMeta = {
      ...(candidate as object),
      order: order,
      // Doc-sourced, so labelled as such — the confidence tier exists precisely
      // to keep this distinguishable from a guess (§6).
      confidence: 'doc_asserted' as const,
      afterStep: input.afterStep,
    };
    const result = AssertionSchema.safeParse(withMeta);
    if (!result.success) {
      log.debug(
        `Dropped a doc-grounded assertion that failed validation: ${result.error.issues
          .map((i) => i.message)
          .join('; ')}`
      );
      continue;
    }
    assertions.push(result.data);
    order++;
  }

  return { assertions, expectations };
}

/**
 * Human-readable provenance for the report.
 *
 * A doc-grounded assertion is only trustworthy if a reader can see WHICH doc it
 * came from, so the citation travels with it.
 */
export function formatExpectations(result: GroundedOracleResult): string {
  if (result.assertions.length === 0) {
    return `No doc-grounded assertions${result.skipped ? ` — ${result.skipped}` : ''}.`;
  }
  const lines = [`${result.assertions.length} assertion(s) grounded in documentation:`];
  for (const a of result.assertions) {
    lines.push(`  • [${a.kind}] ${a.description}`);
  }
  lines.push('', 'Sources:');
  for (const e of result.expectations) {
    const where = e.sourceTitle ? `${e.sourceTitle} — ${e.sourceUrl}` : e.sourceUrl;
    lines.push(`  • ${where} (relevance ${e.score.toFixed(2)})`);
  }
  return lines.join('\n');
}
