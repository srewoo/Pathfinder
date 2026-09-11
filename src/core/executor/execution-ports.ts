/**
 * Execution service ports (fix.md §6).
 *
 * §6 requires the executor to contain zero LLM calls. It previously imported the
 * AI layer for three things — planning, healing, and post-step assertion
 * generation — so the boundary could not be honoured by moving files around: the
 * executor genuinely needed those capabilities mid-run.
 *
 * The resolution is inversion. The executor declares WHAT it needs here; the
 * caller supplies implementations. AI-backed versions live in
 * `core/planner/ai-execution-services.ts`, outside `core/executor/**`, so the
 * lint rule holds without an exemption.
 *
 * This also makes the non-determinism explicit and removable: pass
 * `DETERMINISTIC_SERVICES` and a run performs no model calls at all, which is
 * what lets the benchmark (§10) measure execution without an API key.
 */
import type {
  ExecutionPlan,
  ExecutionStep,
  HealingAttempt,
  StepResult,
  TestCase,
} from '../../storage/schemas';
import type { PlanningMode } from '../planner/test-planner';

export interface PlanRequest {
  tabId: number;
  forceFresh: boolean;
  planningMode: PlanningMode;
  /** Serialized accessibility tree, when a CDP session provided one. */
  accessibilityContext?: string;
}

/**
 * Produce the plan for a test.
 *
 * The one place a model may shape what gets executed. Its output is a plan that
 * is then validated — nothing here reaches the page unchecked.
 */
export type PlanProvider = (testCase: TestCase, request: PlanRequest) => Promise<ExecutionPlan>;

export interface HealOutcome {
  success: boolean;
  healedStep?: ExecutionStep;
  attempt: HealingAttempt;
}

/** Runner used to validate a candidate selector under real execution. */
export type StepRunner = (step: ExecutionStep, tabId: number) => Promise<StepResult>;

/**
 * Attempt to repair a failed step.
 *
 * Injected rather than imported because the AI tier of healing makes a run
 * non-reproducible; a caller that wants determinism supplies a healer that only
 * tries the deterministic tiers, or none at all.
 */
/**
 * Evidence about the failure that a healer may use.
 *
 * The executor already captures a screenshot at the exact moment a step fails —
 * before healing perturbs the page — and previously only attached it to the
 * report. Passing it here is what makes a vision healing tier possible at all.
 *
 * Optional throughout: a healer that ignores it behaves exactly as before.
 */
export interface HealContext {
  /** Base64 PNG captured at the moment the step failed. */
  screenshot?: string;
}

export type StepHealer = (
  step: ExecutionStep,
  error: string,
  tabId: number,
  runner: StepRunner,
  context?: HealContext
) => Promise<HealOutcome>;

/** Suggest an assertion for the state a step just produced. Null = none. */
export type AssertionSuggester = (
  tabId: number,
  step: ExecutionStep,
  previousUrl: string
) => Promise<ExecutionStep | null>;

/**
 * Everything the executor needs that it must not import.
 *
 * Optional members mean "capability absent", and absence is a supported mode
 * rather than a broken one: no healer simply means a failed step stays failed.
 */
export interface ExecutionServices {
  plan: PlanProvider;
  heal?: StepHealer;
  suggestAssertion?: AssertionSuggester;
}

/**
 * Services that perform no model calls.
 *
 * `plan` throws, because a test with no stored plan genuinely cannot run without
 * one — returning an empty plan would produce a test that passes while doing
 * nothing, which is the failure mode this whole document is built to prevent.
 */
export const DETERMINISTIC_SERVICES: ExecutionServices = {
  plan: async (testCase) => {
    throw new Error(
      `No stored plan for "${testCase.title}" and planning is disabled. ` +
        `Generate the plan first, or supply AI-backed execution services.`
    );
  },
};

/** Services built from a stored plan only — no planning, no healing, no AI. */
export function storedPlanServices(plans: ReadonlyMap<string, ExecutionPlan>): ExecutionServices {
  return {
    plan: async (testCase) => {
      const plan = plans.get(testCase.id);
      if (!plan) {
        throw new Error(`No stored plan for test "${testCase.id}"`);
      }
      return plan;
    },
  };
}
