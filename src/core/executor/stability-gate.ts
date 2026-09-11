/**
 * Pre-acceptance stability gate.
 *
 * `reporting/flake-detector.ts` answers "has this test been flaky?" from
 * history — which only helps after a flaky test has already polluted several
 * runs and someone has noticed. The trust problem with a freshly generated test
 * is a different question: is it repeatable AT ALL? Running it N times back to
 * back and judging the spread answers that before anyone relies on it.
 *
 * The distinction that matters is unstable vs failing. A test that fails every
 * time is broken and must stay visible. A test that disagrees with itself is
 * untrustworthy and gets quarantined — kept, excluded from suite runs, flagged
 * for a human. Conflating the two would hide real breakage behind a
 * "quarantined" label.
 *
 * The runner is injected, so this module performs no execution and no
 * persistence and is testable without a browser.
 */
import type { TestCase, TestResult } from '../../storage/schemas';
import { detectFlakes, type FlakeStats } from '../reporting/flake-detector';
import { createLogger } from '../../utils/logger';

const log = createLogger('stability-gate');

/** Three is the smallest N that can distinguish "flaky" from "just failed". */
const DEFAULT_ATTEMPTS = 3;

export type StabilityVerdict = 'stable' | 'unstable' | 'failing';

export interface GateReport {
  verdict: StabilityVerdict;
  runs: TestResult[];
  flake: FlakeStats;
  /** True only for `unstable`. A failing test must stay visible, not be hidden. */
  quarantine: boolean;
  summary: string;
}

export interface GateArgs {
  testCase: TestCase;
  /** Number of back-to-back runs. Default 3. */
  attempts?: number;
  /** Executes one attempt. Injected so the gate needs no browser to test. */
  run: (attempt: number) => Promise<TestResult>;
  signal?: AbortSignal;
}

/**
 * A synthetic result for an attempt that threw before producing one.
 *
 * A crashed attempt is evidence — usually the strongest evidence of
 * instability — so it is recorded as an error rather than dropped.
 */
function errorResult(testCase: TestCase, attempt: number, err: unknown): TestResult {
  const now = new Date().toISOString();
  return {
    id: `gate-${testCase.id}-${attempt}`,
    testCaseId: testCase.id,
    testCaseTitle: testCase.title,
    status: 'error',
    startedAt: now,
    completedAt: now,
    duration: 0,
    steps: [],
    healingAttempts: [],
    runId: `gate-${testCase.id}`,
    errorMessage: err instanceof Error ? err.message : String(err),
  };
}

function verdictFor(runs: readonly TestResult[]): StabilityVerdict {
  const passed = runs.filter((r) => r.status === 'passed').length;
  if (passed === runs.length) return 'stable';
  if (passed === 0) return 'failing';
  return 'unstable';
}

function summarize(runs: readonly TestResult[], verdict: StabilityVerdict): string {
  const count = (status: TestResult['status']) => runs.filter((r) => r.status === status).length;
  const parts = [
    `${count('passed')} passed`,
    `${count('failed')} failed`,
    `${count('error')} errored`,
  ];
  return `${verdict} over ${runs.length} run(s): ${parts.join(', ')}`;
}

export async function runStabilityGate(args: GateArgs): Promise<GateReport> {
  const attempts = Math.max(1, args.attempts ?? DEFAULT_ATTEMPTS);
  const runs: TestResult[] = [];

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      runs.push(await args.run(attempt));
    } catch (err) {
      log.warn(`Stability attempt ${attempt + 1} threw`, err);
      runs.push(errorResult(args.testCase, attempt, err));
    }
    // Checked after the attempt, not before: an aborted gate still judges what
    // it managed to observe rather than discarding it.
    if (args.signal?.aborted) {
      log.info(`Stability gate aborted after ${runs.length} run(s)`);
      break;
    }
  }

  const verdict = verdictFor(runs);
  return {
    verdict,
    runs,
    flake: detectFlakes(args.testCase.id, runs),
    quarantine: verdict === 'unstable',
    summary: summarize(runs, verdict),
  };
}
