/**
 * Bridge from stored test cases to emitted Playwright source.
 *
 * Kept separate from the emitter so the emitter depends only on the IR: this
 * file is the only place that knows about `TestCase` and `ExecutionStep`.
 *
 * Conversion goes through `testCaseToIR`, which is already tested and already
 * reports what it could not represent. Reusing it means the exporter inherits
 * the IR's guarantees — including the refusal to produce a test with no
 * assertions — instead of re-deriving them and getting them subtly wrong.
 */
import type { ExecutionStep, TestCase, TestResult } from '../../storage/schemas';
import { testCaseToIR } from '../ir/ir-bridge';
import type { TestIR } from '../ir/test-ir';
import { emitPlaywrightSuite, type EmitResult } from './playwright-emitter';

export interface ExportInput {
  testCase: TestCase;
  /** The executed or stored plan for this test. */
  steps: readonly ExecutionStep[];
}

export function buildPlaywrightExport(inputs: readonly ExportInput[]): EmitResult {
  const irs: TestIR[] = [];
  const dropped: string[] = [];

  for (const { testCase, steps } of inputs) {
    const converted = testCaseToIR(testCase, steps);

    // Per-step losses, each already carrying its own reason.
    for (const d of converted.dropped) {
      dropped.push(`"${testCase.title}" step ${d.order} (${d.action}): ${d.reason}`);
    }

    if (!converted.ir) {
      // Conversion failed outright. Name the test — a bare schema message in a
      // multi-test export tells the user nothing about which one to fix.
      const why = converted.errors.length > 0 ? converted.errors.join('; ') : 'conversion failed';
      dropped.push(`"${testCase.title}" was not exported: ${why}`);
      continue;
    }
    irs.push(converted.ir);
  }

  const emitted = emitPlaywrightSuite(irs);
  return { source: emitted.source, dropped: [...dropped, ...emitted.dropped] };
}

/**
 * Build export inputs from run results.
 *
 * The steps come from `stepResults`, not from a stored plan: that is what
 * actually executed against the page. Exporting the plan instead would export a
 * test that was never run — including selectors that self-healing had already
 * replaced at run time, which is precisely the version that does not work.
 *
 * Skipped steps are excluded. A resumed run records its skipped prefix, and
 * emitting those would produce a spec that starts mid-flow.
 */
export function exportInputsFromResults(
  results: readonly TestResult[],
  testCases: readonly TestCase[]
): ExportInput[] {
  const byId = new Map(testCases.map((tc) => [tc.id, tc]));

  return results.map((result) => {
    const stored = byId.get(result.testCaseId);
    const testCase: TestCase =
      stored ??
      // The test case was deleted but its result survives — export it anyway
      // rather than dropping a run the user can still see on screen.
      {
        id: result.testCaseId,
        title: result.testCaseTitle,
        description: '',
        type: 'positive',
        source: 'generated',
        status: result.status === 'passed' ? 'passed' : 'failed',
        createdAt: result.startedAt,
      };

    return {
      testCase,
      steps: result.steps.filter((s) => s.status !== 'skipped').map((s) => s.step),
    };
  });
}
