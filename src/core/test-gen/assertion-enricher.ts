/**
 * Deterministic assertion enrichment — the fix for shallow oracles.
 *
 * The problem this solves: generated tests overwhelmingly ended with
 * `assert visible .success` or `assert text "Saved"`. Those pass when the app
 * renders a banner, whether or not anything happened. A test suite made of them
 * confirms the UI is not crashing, which is not the same as confirming the
 * product works.
 *
 * The insight: exploration ALREADY observed the truth. `PageNode.apiEndpoints`
 * records which endpoints a form submit actually hit and with what status.
 * `FormSubmissionOutcome` records the real result URL and the real error
 * selectors. That is ground truth, captured from the running app — so deep,
 * multi-channel assertions can be derived from it with **zero tokens and no
 * guessing**.
 *
 * Every assertion added here is `grounded`: it asserts something that was
 * OBSERVED to happen, not something a model believed should happen. That is what
 * keeps the false-positive rate low while raising the depth.
 */
import type {
  ExecutionStep,
  FormSubmissionOutcome,
  InteractionGraph,
  ObservedAPI,
  PageNode,
} from '../../storage/schemas';

/** Channels an assertion can inspect. Depth = how many are covered. */
export type AssertionChannel = 'dom' | 'network' | 'url' | 'absence';

export interface EnrichmentResult {
  steps: ExecutionStep[];
  /** Assertions added, for reporting. */
  added: Array<{ afterStep: number; assertType: string; expected?: string; why: string }>;
  /** Channels the enriched test now asserts on. */
  channels: AssertionChannel[];
}

/** Actions whose effect is worth asserting on more than one channel. */
const SUBMIT_ACTIONS = new Set(['click', 'press_key']);

/**
 * Add grounded, multi-channel assertions to a generated plan.
 *
 * Idempotent: re-running does not duplicate assertions, because each candidate is
 * checked against what the plan already asserts. Generation runs more than once
 * (regeneration, healing, re-planning) and a plan that grew three copies of the
 * same assertion on each pass would be both slow and unreadable.
 */
export function enrichAssertions(
  steps: readonly ExecutionStep[],
  graph: InteractionGraph | undefined,
  opts: { pageUrl?: string; negative?: boolean } = {}
): EnrichmentResult {
  const added: EnrichmentResult['added'] = [];
  if (steps.length === 0) return { steps: [...steps], added, channels: [] };

  const node = findNode(graph, opts.pageUrl);
  const submitApis = (node?.apiEndpoints ?? []).filter((a) => a.context === 'form_submit');
  const outcome = pickOutcome(node);

  const out: ExecutionStep[] = [];
  const existing = describeExisting(steps);

  for (const step of [...steps].sort((a, b) => a.order - b.order)) {
    out.push(step);

    // Only enrich after the action that actually causes the effect.
    if (!SUBMIT_ACTIONS.has(step.action)) continue;
    if (!looksLikeSubmit(step)) continue;

    const candidates: ExecutionStep[] = [];

    // ── Network channel: the strongest available oracle ────────────────────
    //
    // A DOM assertion cannot distinguish "saved" from "rendered the word saved".
    // An observed endpoint can. Only endpoints exploration actually saw are used,
    // so this never invents an API that does not exist.
    const api = pickApi(submitApis);
    if (api) {
      if (opts.negative) {
        // A negative test asserts the write did NOT happen — the sharpest possible
        // check for a validation bypass, and one no banner assertion can make.
        candidates.push({
          order: 0,
          action: 'assert',
          assertType: 'api_not_called',
          assertExpected: `${api.method} ${pathOf(api.endpoint)}`,
          description: `Invalid input must NOT reach ${api.method} ${pathOf(api.endpoint)}`,
        });
      } else {
        candidates.push({
          order: 0,
          action: 'assert',
          assertType: 'api_status',
          assertExpected: `${api.method} ${pathOf(api.endpoint)} ${statusClass(api.status)}`,
          description: `Submit must reach ${api.method} ${pathOf(api.endpoint)} and succeed`,
        });
      }
    }

    // ── URL channel: exploration recorded where a real submit landed ───────
    if (!opts.negative && outcome?.result === 'navigation' && outcome.resultUrl) {
      const path = pathOf(outcome.resultUrl);
      if (path && path !== '/') {
        candidates.push({
          order: 0,
          action: 'assert',
          assertType: 'url',
          assertExpected: path,
          description: `A successful submit navigates to ${path} (observed during exploration)`,
        });
      }
    }

    // ── Absence channel: the error selectors exploration actually saw ──────
    //
    // Asserting the ABSENCE of a known error element is far stronger than
    // asserting the presence of a success banner: it cannot be satisfied by
    // rendering optimistic text.
    if (!opts.negative && outcome?.errorSelectors?.length) {
      const selector = outcome.errorSelectors.slice(0, 3).join(', ');
      candidates.push({
        order: 0,
        action: 'assert',
        selector,
        assertType: 'not_visible',
        description: `No validation error appears (error elements observed during exploration)`,
      });
    }

    // ── Negative tests: assert the error the app really produces ───────────
    if (opts.negative && outcome?.errorSelectors?.length) {
      candidates.push({
        order: 0,
        action: 'assert',
        selector: outcome.errorSelectors.slice(0, 3).join(', '),
        assertType: 'visible',
        description: `The app's own validation error must appear`,
      });
    }

    for (const candidate of candidates) {
      if (existing.has(signature(candidate))) continue;
      existing.add(signature(candidate));
      out.push(candidate);
      added.push({
        afterStep: step.order,
        assertType: candidate.assertType ?? '',
        expected: candidate.assertExpected,
        why: candidate.description,
      });
    }
  }

  const renumbered = out.map((s, i) => ({ ...s, order: i }));
  return { steps: renumbered, added, channels: channelsOf(renumbered) };
}

// ── Depth measurement ───────────────────────────────────────────────────────

/**
 * Channels a plan's assertions cover.
 *
 * This is the metric that makes "deeper oracles" measurable rather than a claim:
 * a plan asserting only on `dom` is shallow however many assertions it has.
 */
export function channelsOf(steps: readonly ExecutionStep[]): AssertionChannel[] {
  const channels = new Set<AssertionChannel>();
  for (const step of steps) {
    if (step.action !== 'assert') continue;
    const t = step.assertType ?? '';
    if (t.startsWith('api_')) channels.add('network');
    else if (t === 'url') channels.add('url');
    else if (t === 'not_visible' || t === 'not_exists' || t === 'not_text') channels.add('absence');
    else channels.add('dom');
  }
  return [...channels].sort();
}

/**
 * Depth score for a plan, 0–1.
 *
 * Deliberately counts CHANNELS rather than assertions: ten `visible` assertions
 * are not deeper than one, and rewarding count would push generation toward
 * padding.
 */
export function assertionDepth(steps: readonly ExecutionStep[]): number {
  return channelsOf(steps).length / 4;
}

export function describeEnrichment(result: EnrichmentResult): string {
  if (result.added.length === 0) {
    return 'No assertions added — no observed API or form outcome was available to ground one.';
  }
  const lines = [
    `Added ${result.added.length} grounded assertion(s); channels now: ${result.channels.join(', ')}`,
  ];
  for (const a of result.added) {
    lines.push(`  • after step ${a.afterStep}: [${a.assertType}] ${a.why}`);
  }
  return lines.join('\n');
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function findNode(graph: InteractionGraph | undefined, pageUrl?: string): PageNode | undefined {
  if (!graph) return undefined;
  if (pageUrl) {
    const exact = graph.nodes.find((n) => n.url === pageUrl);
    if (exact) return exact;
  }
  // Fall back to any node that actually observed a form submit — better than
  // nothing when the plan's start URL was rewritten or inferred.
  return graph.nodes.find((n) => (n.formOutcomes ?? []).length > 0);
}

function pickOutcome(node: PageNode | undefined): FormSubmissionOutcome | undefined {
  const outcomes = node?.formOutcomes ?? [];
  // Prefer a filled-and-succeeded submit: it records the real success path.
  return (
    outcomes.find((o) => o.result === 'navigation') ??
    outcomes.find((o) => o.result === 'success') ??
    outcomes[0]
  );
}

/**
 * The endpoint most likely to BE the submit.
 *
 * Prefers a mutating verb — a form submit that only issued a GET is usually a
 * search, and asserting a write on it would be wrong.
 */
function pickApi(apis: readonly ObservedAPI[]): ObservedAPI | undefined {
  const mutating = apis.filter((a) =>
    ['POST', 'PUT', 'PATCH', 'DELETE'].includes(a.method.toUpperCase())
  );
  return mutating[0] ?? undefined;
}

/**
 * Does this step look like the action that submits?
 *
 * Conservative on purpose: enriching every click would attach write assertions to
 * navigation links and produce failures on correct behaviour.
 */
function looksLikeSubmit(step: ExecutionStep): boolean {
  if (step.action === 'press_key') return (step.key ?? '') === 'Enter';
  const text = `${step.description} ${step.selector ?? ''}`.toLowerCase();
  return /submit|save|create|sign\s?in|log\s?in|register|send|continue|confirm|apply|update|add|delete|remove/.test(
    text
  );
}

/** 2xx/4xx class rather than an exact code — a 200 vs 201 difference is not a bug. */
function statusClass(status: number): string {
  if (status >= 200 && status < 300) return '2xx';
  if (status >= 400 && status < 500) return '4xx';
  if (status >= 500) return '5xx';
  return String(status);
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    // Already a path, or unparseable — strip any query and use it as-is.
    return url.split('?')[0];
  }
}

function signature(step: ExecutionStep): string {
  return `${step.assertType}|${step.selector ?? ''}|${step.assertExpected ?? ''}`;
}

function describeExisting(steps: readonly ExecutionStep[]): Set<string> {
  const out = new Set<string>();
  for (const s of steps) {
    if (s.action === 'assert') out.add(signature(s));
  }
  return out;
}
