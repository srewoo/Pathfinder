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
