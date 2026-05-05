import { describe, it, expect } from 'vitest';
import {
  formatSlackForSuite, formatLinearForFailure, formatJiraForFailure,
} from '../../../src/core/reporting/integration-formatters';
import type { TestResult, TestRun } from '../../../src/storage/schemas';

const result = (overrides: Partial<TestResult> = {}): TestResult => ({
  id: 'r1', testCaseId: 'tc1', testCaseTitle: 'login flow', status: 'passed',
  startedAt: '2026-05-04T00:00:00Z', duration: 200,
  steps: [
    { step: { order: 1, action: 'navigate', description: 'go' }, status: 'passed', duration: 50 },
    { step: { order: 2, action: 'click', description: 'click submit' }, status: 'failed', duration: 30, error: 'not found' },
  ],
  healingAttempts: [],
  runId: 'run',
  ...overrides,
});

const run = (results: TestResult[]): TestRun => ({
  id: 'run',
  startedAt: '2026-05-04T00:00:00Z',
  testCaseIds: results.map((r) => r.testCaseId),
  results,
  summary: {
    total: results.length,
    passed: results.filter((r) => r.status === 'passed').length,
    failed: results.filter((r) => r.status === 'failed').length,
    error: results.filter((r) => r.status === 'error').length,
    healed: 0,
  },
} as TestRun);

describe('formatSlackForSuite', () => {
  it('given all-pass run when formatting then green emoji + summary', () => {
    const msg = formatSlackForSuite(run([result({ status: 'passed' })]));
    expect(msg.text).toContain(':white_check_mark:');
    expect(msg.blocks.find((b) => b.type === 'section' && b.fields)?.fields).toHaveLength(4);
  });

  it('given failures when formatting then includes failing list block', () => {
    const msg = formatSlackForSuite(run([
      result({ status: 'passed' }),
      result({ id: 'r2', testCaseId: 'tc2', testCaseTitle: 'broken', status: 'failed', errorMessage: 'AssertionError' }),
    ]));
    expect(msg.text).toContain(':x:');
    const failingBlock = msg.blocks.find((b) => b.text?.text?.includes('Failing tests'));
    expect(failingBlock).toBeDefined();
    expect(failingBlock?.text?.text).toContain('broken');
  });

  it('given many failures when formatting then truncates list with "more"', () => {
    const failures = Array.from({ length: 15 }, (_, i) =>
      result({ id: `r${i}`, testCaseId: `tc${i}`, testCaseTitle: `t${i}`, status: 'failed' }),
    );
    const msg = formatSlackForSuite(run(failures));
    const failingBlock = msg.blocks.find((b) => b.text?.text?.includes('Failing tests'));
    expect(failingBlock?.text?.text).toContain('and 5 more');
  });
});

describe('formatLinearForFailure', () => {
  it('given a failed test when formatting then title prefixed with [pathfinder]', () => {
    const issue = formatLinearForFailure(result({ status: 'failed', errorMessage: 'X' }), 'run-1');
    expect(issue.title.startsWith('[pathfinder]')).toBe(true);
    expect(issue.description).toContain('## Pathfinder');
    expect(issue.description).toContain('X');
    expect(issue.labels).toContain('pathfinder');
  });

  it('given healing attempts when formatting then includes healing section', () => {
    const issue = formatLinearForFailure(
      result({
        status: 'failed',
        healingAttempts: [
          { stepOrder: 2, originalSelector: '#old', method: 'similarity', healedSelector: '#new', success: true },
        ],
      }),
      'run-1',
    );
    expect(issue.description).toContain('Healing attempts');
    expect(issue.description).toContain('#old');
    expect(issue.description).toContain('#new');
  });

  it('given long title when formatting then truncates', () => {
    const long = 'x'.repeat(200);
    const issue = formatLinearForFailure(result({ testCaseTitle: long }), 'r');
    expect(issue.title.length).toBeLessThan(120);
  });
});

describe('formatJiraForFailure', () => {
  it('given error status when formatting then priority High', () => {
    const issue = formatJiraForFailure(result({ status: 'error', errorMessage: 'crash' }), 'r');
    expect(issue.priority).toBe('High');
  });

  it('given failed status when formatting then priority Medium', () => {
    const issue = formatJiraForFailure(result({ status: 'failed' }), 'r');
    expect(issue.priority).toBe('Medium');
  });
});
