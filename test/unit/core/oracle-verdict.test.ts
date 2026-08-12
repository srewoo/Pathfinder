/**
 * Oracle findings must change the verdict.
 *
 * A finding nobody sees is the same as no finding. The specific failure this
 * guards: a test whose banner assertion passed while nothing was persisted must
 * NOT report a clean pass — "no assertion failed" is a weaker claim than "nothing
 * went wrong".
 */
import { describe, it, expect } from 'vitest';
import {
  toExportResult,
  verdictWithOracles,
} from '../../../src/core/report/result-adapter';
import { toJUnitXml } from '../../../src/core/report/junit-export';
import { toExportRun } from '../../../src/core/report/result-adapter';
import type { TestResult } from '../../../src/storage/schemas';

const result = (over: Partial<TestResult> = {}): TestResult =>
  ({
    id: 'r1',
    testCaseId: 't1',
    testCaseTitle: 'User can save a note',
    status: 'passed',
    startedAt: '2026-08-11T10:00:00.000Z',
    duration: 400,
    steps: [
      {
        step: { order: 0, action: 'click', selector: '#save', description: 'Click Save' },
        status: 'passed',
        duration: 10,
      },
    ],
    healingAttempts: [],
    runId: 'run-1',
    ...over,
  }) as TestResult;

const finding = (over: Record<string, unknown> = {}) => ({
  kind: 'success-without-persistence',
  severity: 'high' as const,
  message: '"Click Save" reported success but nothing was persisted',
  evidence: 'App showed "Saved successfully" while making zero network requests',
  stepOrder: 0,
  ...over,
});

describe('verdictWithOracles', () => {
  it('given_a_clean_pass_with_no_findings_then_PASS', () => {
    expect(verdictWithOracles(result())).toBe('PASS');
  });

  it('given_a_passing_test_with_a_HIGH_severity_finding_then_NEEDS_REVIEW', () => {
    // The headline case: assertions passed, but the app told nobody.
    expect(verdictWithOracles(result({ oracleFindings: [finding()] }))).toBe('NEEDS_REVIEW');
  });

  it('given_only_medium_or_low_findings_then_the_pass_stands', () => {
    // Not every observation is a defect. A dead-control note is worth reporting
    // without downgrading a test that did what it was asked.
    const soft = result({
      oracleFindings: [
        finding({ kind: 'error-surfaced', severity: 'medium' }),
        finding({ kind: 'dead-button', severity: 'low' }),
      ],
    });
    expect(verdictWithOracles(soft)).toBe('PASS');
  });

  it('given_a_failing_test_then_findings_do_not_soften_it_to_NEEDS_REVIEW', () => {
    const failed = result({ status: 'failed', oracleFindings: [finding()] });
    expect(verdictWithOracles(failed)).toBe('FAIL');
  });

  it('given_healed_locators_AND_a_finding_then_it_is_still_NEEDS_REVIEW_not_worse', () => {
    const both = result({
      oracleFindings: [finding()],
      healingAttempts: [
        { stepOrder: 0, originalSelector: '#a', method: 'similarity', success: true },
        { stepOrder: 1, originalSelector: '#b', method: 'similarity', success: true },
      ],
    });
    expect(verdictWithOracles(both)).toBe('NEEDS_REVIEW');
  });
});

describe('findings reach the report', () => {
  it('given_a_finding_then_its_message_and_evidence_are_in_the_error_text', () => {
    // Folded into the message so a reader who only looks at the failure text
    // cannot miss it.
    const exported = toExportResult(result({ oracleFindings: [finding()] }));
    expect(exported.errorMessage).toContain('success-without-persistence');
    expect(exported.errorMessage).toContain('zero network requests');
  });

  it('given_no_findings_then_the_error_message_is_untouched', () => {
    const exported = toExportResult(result({ status: 'failed', errorMessage: 'Step 2 timed out' }));
    expect(exported.errorMessage).toBe('Step 2 timed out');
  });

  it('given_a_finding_and_an_existing_error_then_both_survive', () => {
    const exported = toExportResult(
      result({ status: 'failed', errorMessage: 'assertion failed', oracleFindings: [finding()] })
    );
    expect(exported.errorMessage).toContain('assertion failed');
    expect(exported.errorMessage).toContain('success-without-persistence');
  });

  it('given_a_finding_then_JUnit_reports_NEEDS_REVIEW_without_failing_the_build', () => {
    // A finding is a prompt to look, not a build break — downgrading it to a
    // failure would train teams to ignore the signal.
    const xml = toJUnitXml(toExportRun([result({ oracleFindings: [finding()] })]));
    expect(xml).toContain('NEEDS_REVIEW');
    expect(xml).toContain('failures="0"');
    expect(xml).toContain('pathfinder.needsReview" value="1"');
  });
});
