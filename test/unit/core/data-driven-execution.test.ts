import { describe, it, expect } from 'vitest';
import { expandDataDrivenCases } from '../../../src/core/executor/test-executor';
import type { TestCase } from '../../../src/storage/schemas';

function tc(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: 'tc1',
    title: 'User can sign in',
    description: '',
    type: 'positive',
    source: 'generated',
    status: 'pending',
    createdAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

describe('expandDataDrivenCases', () => {
  it('given_a_case_with_no_dataset_then_it_yields_exactly_one_run', () => {
    const runs = expandDataDrivenCases([tc()]);
    expect(runs).toHaveLength(1);
    expect(runs[0].dataRowIndex).toBeUndefined();
    expect(runs[0].label).toBe('User can sign in');
  });

  it('given_a_case_with_three_rows_then_it_yields_three_labelled_runs', () => {
    const runs = expandDataDrivenCases([
      tc({ dataSet: { columns: ['email'], rows: [['a@b.com'], ['c@d.com'], ['e@f.com']] } }),
    ]);
    expect(runs).toHaveLength(3);
    expect(runs.map((r) => r.dataRowIndex)).toEqual([0, 1, 2]);
    expect(runs[0].label).toBe('User can sign in [row 1: a@b.com]');
    expect(runs[2].label).toBe('User can sign in [row 3: e@f.com]');
  });

  it('given_a_dataset_with_zero_rows_then_it_yields_one_plain_run', () => {
    const runs = expandDataDrivenCases([tc({ dataSet: { columns: ['email'], rows: [] } })]);
    expect(runs).toHaveLength(1);
    expect(runs[0].dataRowIndex).toBeUndefined();
  });

  it('given_a_quarantined_case_then_it_is_excluded_from_a_suite_run', () => {
    const runs = expandDataDrivenCases([tc({ quarantined: true }), tc({ id: 'tc2' })]);
    expect(runs.map((r) => r.testCase.id)).toEqual(['tc2']);
  });

  // Selecting a test by hand is an explicit choice; quarantine is a default,
  // and a default must not override an explicit instruction.
  it('given_includeQuarantined_then_a_quarantined_case_still_runs', () => {
    const runs = expandDataDrivenCases([tc({ quarantined: true })], { includeQuarantined: true });
    expect(runs).toHaveLength(1);
  });

  it('given_mixed_cases_then_order_is_preserved_and_rows_stay_adjacent', () => {
    const runs = expandDataDrivenCases([
      tc({ id: 'a', dataSet: { columns: ['v'], rows: [['1'], ['2']] } }),
      tc({ id: 'b' }),
    ]);
    expect(runs.map((r) => `${r.testCase.id}:${r.dataRowIndex ?? '-'}`)).toEqual([
      'a:0',
      'a:1',
      'b:-',
    ]);
  });

  it('given_a_quarantined_data_driven_case_then_none_of_its_rows_run', () => {
    const runs = expandDataDrivenCases([
      tc({ quarantined: true, dataSet: { columns: ['v'], rows: [['1'], ['2'], ['3']] } }),
    ]);
    expect(runs).toEqual([]);
  });

  it('given_no_cases_then_no_runs', () => {
    expect(expandDataDrivenCases([])).toEqual([]);
  });
});
