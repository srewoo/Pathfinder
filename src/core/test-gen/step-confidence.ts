import type { FlowStep, StepConfidence } from '../../storage/schemas';

/**
 * Classifies the provenance of a generated test step so the UI can show which
 * steps are high-fidelity (grounded in captured selectors) versus AI-inferred.
 * Confidence reflects GENERATION-TIME knowledge: an "inferred" step may still
 * run fine after the planner grounds it against the graph and self-healing
 * repairs the selector — but at authoring time it wasn't backed by capture.
 */

const ASSERTION_RE = /^(verify|assert|expect|check|confirm|ensure|validate)\b/i;

/** Provenance for a structured flow step (deterministic projection knows the truth). */
export function confidenceFromFlowStep(step: FlowStep, hasKnowledge: boolean): StepConfidence {
  // A captured DOM selector is the strongest signal.
  if (step.selector) return 'grounded';
  // A navigate to a concrete URL came from the explored graph.
  if (step.action === 'navigate' && step.value) return 'grounded';
  // Assertions are doc-asserted when the flow was grounded in documentation.
  if (step.action === 'verify' || step.action === 'assert') {
    return hasKnowledge ? 'doc_asserted' : 'inferred';
  }
  return 'inferred';
}

/**
 * Best-effort provenance for an LLM-authored step string (no structured
 * selector available). Errs toward 'inferred' — these are suggestions the
 * planner/healer ground at run time, not captured selectors.
 */
export function confidenceFromText(step: string, hasKnowledge: boolean): StepConfidence {
  return ASSERTION_RE.test(step.trim()) && hasKnowledge ? 'doc_asserted' : 'inferred';
}

/** How much of a test's steps were backed by capture at authoring time. */
export interface GroundingSummary {
  grounded: number;
  docAsserted: number;
  inferred: number;
  total: number;
  /**
   * True when no step had a captured selector. These are the tests that fail on
   * an element that was never observed, which is indistinguishable from a real
   * regression unless it is labelled.
   */
  allInferred: boolean;
  /**
   * True when the test has steps but not one of them was backed by
   * documentation.
   *
   * Separate from `allInferred` on purpose: element grounding and documentation
   * grounding answer different questions. "Can this test find the button" is
   * not "does anyone claim the button should do this". A test can be perfectly
   * grounded in captured selectors and still be asserting an outcome nobody
   * documented — which is exactly the test that passes while the feature is
   * wrong.
   */
  noDocumentationSupport: boolean;
  /** One line for a card or a preview. */
  label: string;
}

/**
 * Summarise a stored `stepConfidence` array.
 *
 * The single place this is computed. The dots and legend already rendered the
 * per-step values; nothing counted them, so "this whole test is guesswork" was
 * visible only to someone reading every dot.
 */
export function summarizeGrounding(
  confidences: readonly StepConfidence[] | undefined
): GroundingSummary {
  const list = confidences ?? [];
  const grounded = list.filter((c) => c === 'grounded').length;
  const docAsserted = list.filter((c) => c === 'doc_asserted').length;
  const inferred = list.filter((c) => c === 'inferred').length;
  const total = list.length;

  return {
    grounded,
    docAsserted,
    inferred,
    total,
    // An empty list is "not assessed", not "all inferred" — claiming the latter
    // would flag every test authored before confidence was recorded.
    allInferred: total > 0 && grounded === 0,
    noDocumentationSupport: total > 0 && docAsserted === 0,
    label:
      total === 0
        ? 'Grounding not recorded'
        : `${grounded + docAsserted} of ${total} steps grounded`,
  };
}
