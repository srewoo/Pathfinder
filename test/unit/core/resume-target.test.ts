import { describe, it, expect } from 'vitest';
import { firstFailingStepOrder } from '../../../src/core/report/result-adapter';
import {
  skippedPrefix,
  unresolvedPlaceholders,
} from '../../../src/core/executor/test-executor';
import type { ExecutionStep, StepResult, TestResult } from '../../../src/storage/schemas';

function res(statuses: Array<StepResult['status']>): TestResult {
  return {
    id: 'r1',
    testCaseId: 'tc1',
    testCaseTitle: 'T',
    status: 'failed',
    startedAt: '2026-09-10T00:00:00.000Z',
    duration: 1,
    healingAttempts: [],
    runId: 'run1',
    steps: statuses.map((status, order) => ({
      step: { order, action: 'click' as const, selector: '#x', description: `step ${order}` },
      status,
      duration: 1,
    })),
  };
}

describe('firstFailingStepOrder', () => {
  it('given_a_failure_at_step_two_then_returns_two', () => {
    expect(firstFailingStepOrder(res(['passed', 'passed', 'failed']))).toBe(2);
  });

  it('given_all_passed_then_returns_undefined', () => {
    expect(firstFailingStepOrder(res(['passed', 'passed']))).toBeUndefined();
  });

  it('given_two_failures_then_returns_the_earlier_one', () => {
    expect(firstFailingStepOrder(res(['passed', 'failed', 'failed']))).toBe(1);
  });

  // A result from an already-resumed run carries a skipped prefix. Counting
  // those as failures would walk the resume point backwards on every re-run.
  it('given_a_skipped_prefix_then_skipped_steps_are_not_treated_as_failures', () => {
    expect(firstFailingStepOrder(res(['skipped', 'skipped', 'failed']))).toBe(2);
  });

  it('given_no_step_results_then_returns_undefined', () => {
    expect(firstFailingStepOrder({ ...res([]), steps: [] })).toBeUndefined();
  });
});

const steps: ExecutionStep[] = [
  { order: 0, action: 'navigate', value: 'https://x/', description: 'Open' },
  { order: 1, action: 'type', selector: '#a', value: 'v', description: 'Type' },
  { order: 2, action: 'click', selector: '#b', description: 'Click' },
  { order: 3, action: 'assert', assertType: 'visible', selector: '#c', description: 'Assert' },
];

describe('skippedPrefix', () => {
  // Marked skipped, never passed: a resumed run must not claim it verified
  // steps it did not execute, or the result is a false green.
  it('given_start_from_two_then_steps_zero_and_one_are_skipped', () => {
    const prefix = skippedPrefix(steps, 2);
    expect(prefix).toHaveLength(2);
    expect(prefix.every((r) => r.status === 'skipped')).toBe(true);
    expect(prefix.map((r) => r.step.order)).toEqual([0, 1]);
  });

  it('given_skipped_results_then_each_carries_a_reason', () => {
    expect(skippedPrefix(steps, 1)[0].error).toMatch(/resum/i);
  });

  it('given_start_from_zero_then_nothing_is_skipped', () => {
    expect(skippedPrefix(steps, 0)).toEqual([]);
  });

  it('given_start_from_beyond_the_last_step_then_all_are_skipped', () => {
    expect(skippedPrefix(steps, 99)).toHaveLength(4);
  });

  it('given_a_negative_start_then_nothing_is_skipped', () => {
    expect(skippedPrefix(steps, -3)).toEqual([]);
  });

  it('given_unsorted_steps_then_the_prefix_is_chosen_by_order_not_array_position', () => {
    const shuffled = [steps[2], steps[0], steps[3], steps[1]];
    expect(skippedPrefix(shuffled, 2).map((r) => r.step.order)).toEqual([0, 1]);
  });

  it('given_skipped_results_then_duration_is_zero', () => {
    expect(skippedPrefix(steps, 2).every((r) => r.duration === 0)).toBe(true);
  });
});

describe('unresolvedPlaceholders', () => {
  function step(overrides: Partial<ExecutionStep>): ExecutionStep {
    return { order: 1, action: 'type', selector: '#x', description: 'Type', ...overrides };
  }

  it('given_a_value_with_a_placeholder_then_its_name_is_returned', () => {
    expect(unresolvedPlaceholders(step({ value: '{{orderNo}}' }))).toEqual(['orderNo']);
  });

  it('given_a_placeholder_inside_surrounding_text_then_it_is_still_found', () => {
    expect(unresolvedPlaceholders(step({ value: 'order {{orderNo}} please' }))).toEqual(['orderNo']);
  });

  it('given_whitespace_inside_the_braces_then_it_is_still_found', () => {
    expect(unresolvedPlaceholders(step({ value: '{{ orderNo }}' }))).toEqual(['orderNo']);
  });

  it('given_a_placeholder_in_an_assertion_expectation_then_it_is_found', () => {
    expect(
      unresolvedPlaceholders(step({ action: 'assert', assertExpected: '{{total}}' }))
    ).toEqual(['total']);
  });

  it('given_the_same_name_twice_then_it_is_reported_once', () => {
    expect(unresolvedPlaceholders(step({ value: '{{a}} and {{a}}' }))).toEqual(['a']);
  });

  it('given_several_names_then_all_are_reported', () => {
    expect(unresolvedPlaceholders(step({ value: '{{a}}/{{b}}' }))).toEqual(['a', 'b']);
  });

  it('given_a_fully_resolved_value_then_nothing_is_returned', () => {
    expect(unresolvedPlaceholders(step({ value: 'a@b.com' }))).toEqual([]);
  });

  it('given_no_value_at_all_then_nothing_is_returned', () => {
    expect(unresolvedPlaceholders(step({}))).toEqual([]);
  });

  it('given_a_single_brace_then_it_is_not_a_placeholder', () => {
    expect(unresolvedPlaceholders(step({ value: '{orderNo}' }))).toEqual([]);
  });
});
