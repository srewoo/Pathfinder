import { describe, it, expect, vi } from 'vitest';
import {
  importRunAsTestCases,
  pushResultsToTestRail,
  formatElapsed,
  statusIdFor,
  testRailConfigFrom,
  caseIdFromTestCaseId,
} from '../../../src/core/integrations/testrail-sync';
import type { Settings, TestResult } from '../../../src/storage/schemas';

function result(overrides: Partial<TestResult> = {}): TestResult {
  return {
    id: 'r1',
    testCaseId: 'tc1',
    testCaseTitle: 'Sign in',
    status: 'passed',
    startedAt: '2026-09-10T00:00:00.000Z',
    duration: 3200,
    steps: [],
    healingAttempts: [],
    runId: 'run1',
    ...overrides,
  };
}

describe('statusIdFor', () => {
  it.each([
    ['passed', 1],
    ['failed', 5],
    ['error', 5],
    ['running', 4],
  ] as const)('given_%s_then_status_id_is_%i', (status, id) => {
    expect(statusIdFor(status as TestResult['status'])).toBe(id);
  });
});

describe('formatElapsed', () => {
  it('given_3200ms_then_3s', () => expect(formatElapsed(3200)).toBe('3s'));
  it('given_135000ms_then_2m_15s', () => expect(formatElapsed(135000)).toBe('2m 15s'));
  it('given_120000ms_then_2m', () => expect(formatElapsed(120000)).toBe('2m'));
  // TestRail rejects '0s', so a sub-second run must send nothing at all.
  it('given_400ms_then_undefined', () => expect(formatElapsed(400)).toBeUndefined());
  it('given_zero_then_undefined', () => expect(formatElapsed(0)).toBeUndefined());
  it('given_undefined_then_undefined', () => expect(formatElapsed(undefined)).toBeUndefined());
});

describe('importRunAsTestCases', () => {
  it('given_testrail_tests_then_maps_them_to_test_cases_with_steps', () => {
    const cases = importRunAsTestCases(
      [{ id: 7, caseId: 900, title: 'Sign in', steps: ['Open login', 'Enter credentials'] }],
      42
    );
    expect(cases).toHaveLength(1);
    expect(cases[0].title).toBe('Sign in');
    expect(cases[0].steps).toEqual(['Open login', 'Enter credentials']);
    expect(cases[0].source).toBe('user');
    expect(cases[0].status).toBe('pending');
  });

  it('given_a_test_then_the_id_encodes_the_run_and_case_so_re_import_is_idempotent', () => {
    const first = importRunAsTestCases([{ id: 7, caseId: 900, title: 'A', steps: [] }], 42);
    const second = importRunAsTestCases([{ id: 7, caseId: 900, title: 'A', steps: [] }], 42);
    expect(first[0].id).toBe(second[0].id);
    expect(first[0].id).toBe('testrail-42-900');
  });

  // An empty array would read as "a test with zero steps", which executes
  // nothing and passes. Absent means "needs expansion".
  it('given_a_test_with_no_steps_then_steps_is_undefined_not_an_empty_array', () => {
    expect(importRunAsTestCases([{ id: 7, caseId: 900, title: 'A', steps: [] }], 42)[0].steps).toBeUndefined();
  });

  it('given_a_test_then_the_description_records_where_it_came_from', () => {
    const [tc] = importRunAsTestCases([{ id: 7, caseId: 900, title: 'A', steps: [] }], 42);
    expect(tc.description).toContain('run 42');
    expect(tc.description).toContain('C900');
  });
});

describe('pushResultsToTestRail', () => {
  function clientStub() {
    return {
      getTests: vi.fn(),
      addResultForCase: vi.fn(async (_runId: number, _caseId: number, _body: { comment?: string }) => ({
        id: 555,
      })),
      addAttachmentToResult: vi.fn(async (_resultId: number, _png: Blob, _name: string) => ({ id: 12 })),
    };
  }

  it('given_two_results_then_one_result_is_posted_per_case', async () => {
    const client = clientStub();
    const summary = await pushResultsToTestRail({
      runId: 42,
      results: [result(), result({ id: 'r2', testCaseId: 'tc2' })],
      client: client as never,
      caseIdFor: (r) => (r.testCaseId === 'tc1' ? 900 : 901),
    });
    expect(client.addResultForCase).toHaveBeenCalledTimes(2);
    expect(summary.pushed).toBe(2);
    expect(summary.failures).toEqual([]);
  });

  it('given_a_failure_with_a_screenshot_then_the_png_is_attached_to_the_result', async () => {
    const client = clientStub();
    const summary = await pushResultsToTestRail({
      runId: 42,
      results: [result({ status: 'failed', errorMessage: 'not found', screenshot: 'AAAA' })],
      client: client as never,
      caseIdFor: () => 900,
    });
    expect(client.addAttachmentToResult).toHaveBeenCalledTimes(1);
    expect(client.addAttachmentToResult.mock.calls[0][0]).toBe(555);
    expect(summary.attached).toBe(1);
  });

  it('given_a_failure_whose_screenshot_is_on_the_failing_step_then_it_is_still_attached', async () => {
    const client = clientStub();
    const summary = await pushResultsToTestRail({
      runId: 42,
      results: [
        result({
          status: 'failed',
          steps: [
            {
              step: { order: 0, action: 'click', selector: '#x', description: 'Click' },
              status: 'failed',
              duration: 1,
              screenshot: 'BBBB',
            },
          ],
        }),
      ],
      client: client as never,
      caseIdFor: () => 900,
    });
    expect(summary.attached).toBe(1);
  });

  it('given_a_pass_with_a_screenshot_then_nothing_is_attached', async () => {
    const client = clientStub();
    await pushResultsToTestRail({
      runId: 42,
      results: [result({ status: 'passed', screenshot: 'AAAA' })],
      client: client as never,
      caseIdFor: () => 900,
    });
    expect(client.addAttachmentToResult).not.toHaveBeenCalled();
  });

  it('given_a_result_with_no_mapped_case_id_then_it_is_skipped_and_reported', async () => {
    const client = clientStub();
    const summary = await pushResultsToTestRail({
      runId: 42,
      results: [result()],
      client: client as never,
      caseIdFor: () => undefined,
    });
    expect(client.addResultForCase).not.toHaveBeenCalled();
    expect(summary.pushed).toBe(0);
    expect(summary.failures[0].error).toMatch(/no TestRail case/i);
  });

  it('given_the_error_message_then_it_is_included_in_the_comment', async () => {
    const client = clientStub();
    await pushResultsToTestRail({
      runId: 42,
      results: [result({ status: 'failed', errorMessage: 'element #save not found' })],
      client: client as never,
      caseIdFor: () => 900,
    });
    expect(client.addResultForCase.mock.calls[0][2].comment).toContain('element #save not found');
  });

  it('given_healed_steps_then_the_comment_says_how_many', async () => {
    const client = clientStub();
    await pushResultsToTestRail({
      runId: 42,
      results: [
        result({
          steps: [
            {
              step: { order: 0, action: 'click', selector: '#x', description: 'Click' },
              status: 'passed',
              duration: 1,
              healingAttempt: {
                stepOrder: 0,
                originalSelector: '#x',
                method: 'visual',
                success: true,
              },
            },
          ],
        }),
      ],
      client: client as never,
      caseIdFor: () => 900,
    });
    expect(client.addResultForCase.mock.calls[0][2].comment).toMatch(/1 selector\(s\) self-healed/);
  });

  // One bad case must not abandon the rest of the run's results.
  it('given_one_post_throws_then_the_others_still_push_and_the_failure_is_reported', async () => {
    const client = clientStub();
    client.addResultForCase.mockImplementationOnce(async () => {
      throw new Error('500');
    });
    const summary = await pushResultsToTestRail({
      runId: 42,
      results: [result(), result({ id: 'r2', testCaseId: 'tc2' })],
      client: client as never,
      caseIdFor: (r) => (r.testCaseId === 'tc1' ? 900 : 901),
    });
    expect(summary.pushed).toBe(1);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0].caseId).toBe(900);
  });

  it('given_an_attachment_that_fails_then_the_result_still_counts_as_pushed', async () => {
    const client = clientStub();
    client.addAttachmentToResult.mockImplementationOnce(async () => {
      throw new Error('413');
    });
    const summary = await pushResultsToTestRail({
      runId: 42,
      results: [result({ status: 'failed', screenshot: 'AAAA' })],
      client: client as never,
      caseIdFor: () => 900,
    });
    expect(summary.pushed).toBe(1);
    expect(summary.attached).toBe(0);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0].error).toMatch(/screenshot did not attach/i);
  });

  it('given_no_results_then_an_empty_summary_and_no_calls', async () => {
    const client = clientStub();
    const summary = await pushResultsToTestRail({
      runId: 42,
      results: [],
      client: client as never,
      caseIdFor: () => 900,
    });
    expect(summary).toEqual({ pushed: 0, attached: 0, failures: [] });
    expect(client.addResultForCase).not.toHaveBeenCalled();
  });
});

describe('testRailConfigFrom', () => {
  const base = {} as Settings;

  it('given_all_three_fields_then_returns_a_config', () => {
    const settings = {
      ...base,
      testrail: { host: 'https://acme.testrail.io', email: 'a@b.com', apiKey: 'K' },
    };
    expect(testRailConfigFrom(settings)).toEqual({
      host: 'https://acme.testrail.io',
      email: 'a@b.com',
      apiKey: 'K',
    });
  });

  it('given_no_testrail_settings_then_undefined', () => {
    expect(testRailConfigFrom(base)).toBeUndefined();
  });

  it.each(['host', 'email', 'apiKey'])('given_a_missing_%s_then_undefined', (field) => {
    const testrail = { host: 'h', email: 'e', apiKey: 'k', [field]: '' };
    expect(testRailConfigFrom({ ...base, testrail } as Settings)).toBeUndefined();
  });
});

describe('caseIdFromTestCaseId', () => {
  it('given_an_imported_id_then_extracts_the_case_id', () => {
    expect(caseIdFromTestCaseId('testrail-42-900')).toBe(900);
  });

  it('given_a_non_testrail_id_then_undefined', () => {
    expect(caseIdFromTestCaseId('abc123')).toBeUndefined();
  });

  it('given_a_malformed_testrail_id_then_undefined', () => {
    expect(caseIdFromTestCaseId('testrail-42-')).toBeUndefined();
  });
});
