import type { Flow, FlowStep, TestCase, FlowCoverageType } from '../../storage/schemas';
import { testCaseDB } from '../../storage/indexed-db';
import { generateId } from '../../utils/hash';
import { createLogger } from '../../utils/logger';
import { confidenceFromFlowStep } from './step-confidence';

const log = createLogger('flow-projection');

/**
 * Phase 3 of the graph-first flow design: turn a Flow into an executable test
 * case DETERMINISTICALLY — no LLM. A flow already carries everything a test
 * needs: ordered steps with the explorer's captured selectors, a start URL, an
 * expected outcome (oracle), and a coverage type. So projection is a mechanical
 * transform, and it guarantees at least one runnable test per flow even when the
 * LLM generation call is skipped, fails, or drops the long tail.
 *
 * The LLM generator (`generateTestsForFlow`) still runs on top for richer,
 * multi-data-variant cases; projection is the reliable floor beneath it.
 */

/** Map a flow's coverage category to the TestCase type taxonomy. */
export function coverageTypeToTestType(coverage: FlowCoverageType | undefined): TestCase['type'] {
  switch (coverage) {
    case 'validation':
      return 'negative';
    case 'boundary':
    case 'empty':
      return 'edge';
    case 'happy':
    case 'navigation':
    case 'exploratory':
    default:
      return 'positive';
  }
}

/** Render one flow step as a human-readable, executable instruction. */
export function stepToInstruction(step: FlowStep): string {
  const where = step.target ? ` ${quoteIfText(step.target)}` : '';
  switch (step.action) {
    case 'navigate':
      return `Navigate to ${step.value || step.target || 'the page'}`;
    case 'type':
    case 'fill':
      return `Enter "${step.value ?? ''}" into${where || ' the field'}`;
    case 'select':
      return `Select "${step.value ?? ''}" in${where || ' the dropdown'}`;
    case 'check':
      return `Check${where || ' the checkbox'}`;
    case 'uncheck':
      return `Uncheck${where || ' the checkbox'}`;
    case 'click':
      return `Click${where || ' the element'}`;
    case 'verify':
    case 'assert':
      return `Verify ${step.expectedOutcome || step.target || 'the result'}`;
    default:
      return step.description || `${step.action}${where}`.trim();
  }
}

/** A non-URL target is a label and reads better quoted. */
function quoteIfText(target: string): string {
  return /^https?:\/\//i.test(target) ? target : `"${target}"`;
}

/**
 * Project a flow into its canonical executable test case (a draft — no DB).
 * One test per flow: the flow's own realization. Field-level data variations
 * (other boundary values, etc.) are produced separately by the constraint
 * generator, so projection stays one-to-one and doesn't double up.
 */
export function projectFlowToTestCases(flow: Flow): Array<Omit<TestCase, 'status' | 'createdAt'>> {
  if (!flow.steps || flow.steps.length === 0) return [];

  const ordered = [...flow.steps].sort((a, b) => a.order - b.order);
  const hasKnowledge = (flow.knowledgeRefs?.length ?? 0) > 0;
  const steps = ordered.map(stepToInstruction);
  const stepConfidence = ordered.map((s) => confidenceFromFlowStep(s, hasKnowledge));
  const grounded = hasKnowledge
    ? ` Grounded in docs: ${flow.knowledgeRefs!.map((r) => r.section || r.url).slice(0, 2).join(', ')}.`
    : '';

  return [
    {
      id: generateId(),
      title: flow.name,
      description: `${flow.description}${grounded}`.trim(),
      type: coverageTypeToTestType(flow.coverageType),
      sourceFlowId: flow.flowId,
      source: 'generated',
      steps,
      stepConfidence,
      startUrl: flow.startUrl,
    },
  ];
}

/**
 * Persist projected tests for a flow, skipping any whose normalized title is
 * already present (e.g. an LLM-generated test with the same name). Returns the
 * tests that were actually created.
 */
export async function saveProjectedTests(
  flow: Flow,
  existingTitles: Set<string> = new Set()
): Promise<TestCase[]> {
  const drafts = projectFlowToTestCases(flow);
  const saved: TestCase[] = [];
  for (const draft of drafts) {
    const norm = draft.title.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (existingTitles.has(norm)) continue;
    existingTitles.add(norm);
    const testCase: TestCase = { ...draft, status: 'pending', createdAt: new Date().toISOString() };
    await testCaseDB.put(testCase);
    saved.push(testCase);
  }
  if (saved.length > 0) log.info(`Projected ${saved.length} deterministic test(s) from flow "${flow.name}"`);
  return saved;
}
