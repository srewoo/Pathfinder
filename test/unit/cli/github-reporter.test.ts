import { describe, it, expect } from 'vitest';
import { emitGithubAnnotations, buildJobSummary } from '../../../cli/src/github-reporter';
import type { TestResult } from '../../../cli/src/types';

const passing: TestResult = {
  id: 'r1', testCaseId: 'tc1', testCaseTitle: 'happy path', status: 'passed',
  startedAt: '', completedAt: '', duration: 1230, steps: [], runId: 'run',
};
const failing: TestResult = {
  ...passing, id: 'r2', testCaseId: 'tc2', testCaseTitle: 'broken: pipe | one',
  status: 'failed', errorMessage: 'expected\nactual',
};
const errored: TestResult = {
  ...passing, id: 'r3', testCaseId: 'tc3', testCaseTitle: 'crash',
  status: 'error', errorMessage: '50% off',
};

describe('emitGithubAnnotations', () => {
  it('given only passing tests when emitting then returns no annotations', () => {
    expect(emitGithubAnnotations([passing])).toEqual([]);
  });

  it('given failing test when emitting then produces ::error::', () => {
    const lines = emitGithubAnnotations([failing]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^::error /);
    expect(lines[0]).toContain('pathfinder: broken: pipe | one');
  });

  it('given newline in error when emitting then escapes %0A', () => {
    const lines = emitGithubAnnotations([failing]);
    expect(lines[0]).toContain('%0A');
  });

  it('given percent in error when emitting then escapes %25', () => {
    const lines = emitGithubAnnotations([errored]);
    expect(lines[0]).toContain('%25');
  });
});

describe('buildJobSummary', () => {
  it('given mixed results when building then totals are correct', () => {
    const md = buildJobSummary([passing, failing, errored]);
    expect(md).toContain('**1** passed');
    expect(md).toContain('**1** failed');
    expect(md).toContain('**1** errored');
  });

  it('given pipe in title when building then escapes', () => {
    const md = buildJobSummary([failing]);
    expect(md).toContain('broken: pipe \\| one');
  });

  it('given long error when building then truncates', () => {
    const longErr: TestResult = { ...failing, errorMessage: 'x'.repeat(500) };
    const md = buildJobSummary([longErr]);
    expect(md).toContain('…');
  });
});
