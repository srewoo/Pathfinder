import { describe, it, expect } from 'vitest';
import {
  buildPlaywrightExport,
  exportInputsFromResults,
} from '../../../src/core/export/playwright-export';
import type { ExecutionStep, TestCase } from '../../../src/storage/schemas';

const steps: ExecutionStep[] = [
  {
    order: 0,
    action: 'navigate',
    value: 'https://app.example.com/login',
    description: 'Open login',
  },
  {
    order: 1,
    action: 'type',
    selector: "[data-testid='email']",
    value: 'a@b.com',
    description: 'Enter email',
  },
  { order: 2, action: 'click', selector: "[data-testid='submit']", description: 'Submit' },
  {
    order: 3,
    action: 'assert',
    assertType: 'visible',
    selector: "[data-testid='home']",
    description: 'Home visible',
  },
];

const testCase: TestCase = {
  id: 'tc1',
  title: 'User can sign in',
  description: 'happy path',
  type: 'positive',
  source: 'generated',
  status: 'passed',
  createdAt: '2026-09-10T00:00:00.000Z',
  startUrl: 'https://app.example.com/login',
  preplan: steps,
};

describe('buildPlaywrightExport', () => {
  it('given_a_test_case_with_a_plan_then_emits_a_spec_containing_its_actions', () => {
    const { source, dropped } = buildPlaywrightExport([{ testCase, steps }]);
    expect(source).toContain("import { test, expect } from '@playwright/test';");
    expect(source).toContain("test('User can sign in'");
    expect(source).toContain(".fill('a@b.com')");
    expect(source).toContain('.click()');
    expect(dropped).toEqual([]);
  });

  // An IR with no assertions is rejected by the schema — a test that asserts
  // nothing always passes. The exporter must surface that, not emit a shell.
  it('given_a_plan_with_no_assertions_then_it_is_reported_not_silently_emitted', () => {
    const noAssert = steps.filter((s) => s.action !== 'assert');
    const { source, dropped } = buildPlaywrightExport([{ testCase, steps: noAssert }]);
    expect(dropped.join(' ')).toMatch(/assert/i);
    expect(source).not.toContain("test('User can sign in'");
  });

  it('given_the_test_title_then_a_conversion_failure_names_which_test_it_was', () => {
    const noAssert = steps.filter((s) => s.action !== 'assert');
    const { dropped } = buildPlaywrightExport([{ testCase, steps: noAssert }]);
    expect(dropped.join(' ')).toContain('User can sign in');
  });

  it('given_no_inputs_then_a_valid_empty_module_and_no_throw', () => {
    const { source, dropped } = buildPlaywrightExport([]);
    expect(source).toContain('@playwright/test');
    expect(dropped).toEqual([]);
  });

  it('given_two_test_cases_then_both_appear_in_one_file', () => {
    const { source } = buildPlaywrightExport([
      { testCase, steps },
      { testCase: { ...testCase, id: 'tc2', title: 'User can sign out' }, steps },
    ]);
    expect(source).toContain("test('User can sign in'");
    expect(source).toContain("test('User can sign out'");
    expect(source.match(/import \{ test, expect \}/g)).toHaveLength(1);
  });

  it('given_a_step_the_ir_cannot_represent_then_it_is_reported', () => {
    const withWait: ExecutionStep[] = [
      ...steps,
      { order: 4, action: 'wait', value: '1000', description: 'Wait a second' },
    ];
    const { dropped } = buildPlaywrightExport([{ testCase, steps: withWait }]);
    expect(dropped.join(' ')).toMatch(/wait/i);
  });

  it('given_a_test_case_with_no_steps_then_it_is_reported_rather_than_emitted_empty', () => {
    const { dropped } = buildPlaywrightExport([{ testCase, steps: [] }]);
    expect(dropped.length).toBeGreaterThan(0);
  });
});

describe('exportInputsFromResults', () => {
  const executed = steps.map((step) => ({ step, status: 'passed' as const, duration: 1 }));

  function result(overrides: Record<string, unknown> = {}) {
    return {
      id: 'r1',
      testCaseId: 'tc1',
      testCaseTitle: 'User can sign in',
      status: 'passed',
      startedAt: '2026-09-10T00:00:00.000Z',
      duration: 100,
      steps: executed,
      ...overrides,
    } as never;
  }

  it('given_a_result_then_the_steps_come_from_what_actually_executed', () => {
    const inputs = exportInputsFromResults([result()], [testCase]);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].steps.map((s) => s.order)).toEqual([0, 1, 2, 3]);
    expect(inputs[0].testCase.id).toBe('tc1');
  });

  // A resumed run records its skipped prefix; emitting those would produce a
  // spec that starts mid-flow.
  it('given_a_resumed_run_then_skipped_steps_are_excluded', () => {
    const withSkips = [
      { step: steps[0], status: 'skipped' as const, duration: 0 },
      { step: steps[1], status: 'skipped' as const, duration: 0 },
      { step: steps[2], status: 'passed' as const, duration: 1 },
      { step: steps[3], status: 'passed' as const, duration: 1 },
    ];
    const inputs = exportInputsFromResults([result({ steps: withSkips })], [testCase]);
    expect(inputs[0].steps.map((s) => s.order)).toEqual([2, 3]);
  });

  it('given_a_deleted_test_case_then_the_result_is_still_exportable', () => {
    const inputs = exportInputsFromResults([result()], []);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].testCase.title).toBe('User can sign in');
  });
});
