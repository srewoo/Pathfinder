/**
 * The §6 determinism boundary, asserted behaviourally (fix.md §6).
 *
 * The lint rule proves the executor has no AI *imports*. These tests prove the
 * stronger property that matters at runtime: a test can execute end to end with
 * NO model available, and the capabilities that need one are absent-able rather
 * than mandatory.
 *
 * That is what makes a run reproducible, and what lets the benchmark measure
 * execution without an API key.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DETERMINISTIC_SERVICES,
  storedPlanServices,
  type ExecutionServices,
} from '../../src/core/executor/execution-ports';
import type { ExecutionPlan, ExecutionStep, TestCase } from '../../src/storage/schemas';

const plannedSteps: ExecutionStep[] = [
  { order: 0, action: 'navigate', value: 'https://app.test/', description: 'Open' },
  { order: 1, action: 'click', selector: '#go', description: 'Go' },
  { order: 2, action: 'assert', selector: '.ok', assertType: 'visible', description: 'OK' },
];

const testCase = (over: Partial<TestCase> = {}): TestCase =>
  ({
    id: 'tc-1',
    title: 'User can proceed',
    description: 'proceeds',
    startUrl: 'https://app.test/',
    status: 'pending',
    ...over,
  }) as TestCase;

const plan = (): ExecutionPlan => ({
  id: 'p1',
  testCaseId: 'tc-1',
  testCaseHash: 'h',
  steps: plannedSteps,
  cachedAt: new Date(0).toISOString(),
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DETERMINISTIC_SERVICES', () => {
  it('given_no_stored_plan_then_planning_fails_loudly_rather_than_returning_nothing', async () => {
    // An empty plan would produce a test that "passes" while doing nothing —
    // the failure mode this whole document exists to prevent.
    await expect(
      DETERMINISTIC_SERVICES.plan(testCase(), {
        tabId: 1,
        forceFresh: false,
        planningMode: 'auto',
      })
    ).rejects.toThrow(/planning is disabled/);
  });

  it('given_deterministic_services_then_no_healer_or_assertion_suggester_is_present', () => {
    // Absence is a supported mode: a failed step stays failed, and no model is
    // consulted to rescue it.
    expect(DETERMINISTIC_SERVICES.heal).toBeUndefined();
    expect(DETERMINISTIC_SERVICES.suggestAssertion).toBeUndefined();
  });
});

describe('storedPlanServices', () => {
  it('given_a_stored_plan_then_it_is_returned_without_any_model_call', async () => {
    const services = storedPlanServices(new Map([['tc-1', plan()]]));
    const result = await services.plan(testCase(), {
      tabId: 1,
      forceFresh: false,
      planningMode: 'auto',
    });
    expect(result.steps).toEqual(plannedSteps);
  });

  it('given_forceFresh_then_the_stored_plan_is_still_used_because_there_is_no_planner', async () => {
    // Honest behaviour: without a model there is nothing to re-plan WITH, so the
    // stored plan is returned rather than pretending to refresh it.
    const services = storedPlanServices(new Map([['tc-1', plan()]]));
    const result = await services.plan(testCase(), {
      tabId: 1,
      forceFresh: true,
      planningMode: 'auto',
    });
    expect(result.steps).toEqual(plannedSteps);
  });

  it('given_a_missing_plan_then_it_throws_naming_the_test', async () => {
    const services = storedPlanServices(new Map());
    await expect(
      services.plan(testCase({ id: 'tc-absent' }), {
        tabId: 1,
        forceFresh: false,
        planningMode: 'auto',
      })
    ).rejects.toThrow(/tc-absent/);
  });
});

describe('the services contract is satisfiable with zero AI', () => {
  it('given_a_fully_deterministic_service_set_then_it_type_checks_as_ExecutionServices', () => {
    // If this ever required an AI-shaped dependency, the boundary would be
    // nominal rather than real.
    const services: ExecutionServices = {
      plan: async () => plan(),
    };
    expect(services.plan).toBeTypeOf('function');
    expect(services.heal).toBeUndefined();
  });

  it('given_a_healer_that_never_succeeds_then_it_is_a_valid_implementation', async () => {
    const services: ExecutionServices = {
      plan: async () => plan(),
      heal: async (step) => ({
        success: false,
        attempt: {
          stepOrder: step.order,
          originalSelector: step.selector ?? '',
          method: 'similarity',
          success: false,
        },
      }),
    };
    const outcome = await services.heal!(plannedSteps[1], 'not found', 1, async () => ({
      step: plannedSteps[1],
      status: 'failed',
      duration: 1,
    }));
    expect(outcome.success).toBe(false);
    // A failed heal is still recorded, so the report can show it was attempted.
    expect(outcome.attempt.method).toBe('similarity');
  });
});

describe('§6 source-level boundary', () => {
  it('given_the_executor_source_then_it_imports_nothing_from_core_ai', async () => {
    // Belt and braces alongside the lint rule: this fails even if the ESLint
    // override is accidentally disabled (which has happened once already — an
    // empty excludedFiles array silently switched it off).
    const files = ['test-executor.ts', 'ir-executor.ts', 'action-runner.ts', 'assertion-engine.ts'];
    const fs = await import('node:fs/promises');
    for (const file of files) {
      const src = await fs.readFile(`src/core/executor/${file}`, 'utf8');
      const importLines = src
        .split('\n')
        .filter((l) => /^\s*import\s/.test(l) || /^\s*}\s*from\s/.test(l));
      const offending = importLines.filter((l) => /['"][^'"]*\/ai\//.test(l));
      expect(offending, `${file} imports the AI layer: ${offending.join(' | ')}`).toEqual([]);
    }
  });
});
