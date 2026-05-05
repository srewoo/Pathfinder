import { describe, it, expect } from 'vitest';
import { buildTrace } from '../../../src/core/reporting/trace-builder';
import type { TestResult, StepResult } from '../../../src/storage/schemas';

const stepResult = (order: number, overrides: Partial<StepResult> = {}): StepResult => ({
  step: { order, action: 'click', description: 'desc', selector: '#a' },
  status: 'passed',
  duration: 100,
  ...overrides,
});

const result = (overrides: Partial<TestResult> = {}): TestResult => ({
  id: 'r1', testCaseId: 'tc1', testCaseTitle: 'demo', status: 'passed',
  startedAt: '2026-05-04T00:00:00Z',
  steps: [], healingAttempts: [], runId: 'run',
  ...overrides,
});

describe('buildTrace', () => {
  it('given steps when building then orders by offsetMs', () => {
    const t = buildTrace(result({
      steps: [stepResult(1), stepResult(2, { duration: 50 })],
    }));
    const stepOffsets = t.events.filter((e) => e.kind === 'step').map((e) => e.offsetMs);
    expect(stepOffsets).toEqual([0, 100]);
  });

  it('given step with healing when building then emits healing event', () => {
    const t = buildTrace(result({
      steps: [stepResult(1, {
        healingAttempt: { stepOrder: 1, originalSelector: '#a', method: 'similarity', healedSelector: '#b', success: true },
      })],
      healingAttempts: [{ stepOrder: 1, originalSelector: '#a', method: 'similarity', healedSelector: '#b', success: true }],
    }));
    expect(t.events.some((e) => e.kind === 'healing')).toBe(true);
    expect(t.metrics.healingCount).toBe(1);
  });

  it('given har entries when building then distributes across timeline', () => {
    const t = buildTrace(result({
      duration: 1000,
      steps: [stepResult(1)],
      harEntries: [
        { url: '/a', method: 'GET', status: 200, statusText: 'OK', mimeType: 'application/json', duration: 10, bodySize: 10 },
        { url: '/b', method: 'POST', status: 201, statusText: 'Created', mimeType: 'application/json', duration: 20, bodySize: 20 },
      ],
    }));
    expect(t.metrics.networkCount).toBe(2);
    const network = t.events.filter((e) => e.kind === 'network');
    expect(network).toHaveLength(2);
  });

  it('given failed steps when building then counts failedSteps', () => {
    const t = buildTrace(result({
      steps: [stepResult(1), stepResult(2, { status: 'failed', error: 'boom' })],
    }));
    expect(t.metrics.failedSteps).toBe(1);
  });

  it('given screenshot when building then emits screenshot event', () => {
    const t = buildTrace(result({ steps: [stepResult(1)], screenshot: 'base64...' }));
    expect(t.events.some((e) => e.kind === 'screenshot')).toBe(true);
  });

  it('given console events when building then merges them', () => {
    const t = buildTrace(
      result({ steps: [stepResult(1)] }),
      { consoleEvents: [{ timestamp: '2026-05-04T00:00:00.050Z', level: 'error', message: 'oh no' }] },
    );
    const consoleEvts = t.events.filter((e) => e.kind === 'console');
    expect(consoleEvts).toHaveLength(1);
    expect(consoleEvts[0].summary).toContain('oh no');
  });
});
