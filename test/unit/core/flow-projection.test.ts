import { describe, it, expect } from 'vitest';
import {
  coverageTypeToTestType,
  stepToInstruction,
  projectFlowToTestCases,
} from '../../../src/core/test-gen/flow-projection';
import type { Flow, FlowStep } from '../../../src/storage/schemas';

const flow = (partial: Partial<Flow>): Flow => ({
  flowId: 'f1',
  name: 'Flow',
  description: 'desc',
  source: 'exploration',
  steps: [],
  createdAt: '', updatedAt: '',
  ...partial,
});

describe('coverageTypeToTestType', () => {
  it('maps validation → negative, boundary/empty → edge, rest → positive', () => {
    expect(coverageTypeToTestType('validation')).toBe('negative');
    expect(coverageTypeToTestType('boundary')).toBe('edge');
    expect(coverageTypeToTestType('empty')).toBe('edge');
    expect(coverageTypeToTestType('happy')).toBe('positive');
    expect(coverageTypeToTestType('navigation')).toBe('positive');
    expect(coverageTypeToTestType(undefined)).toBe('positive');
  });
});

describe('stepToInstruction', () => {
  const cases: Array<[FlowStep, string]> = [
    [{ order: 1, action: 'navigate', value: 'https://app/x', description: '' }, 'Navigate to https://app/x'],
    [{ order: 1, action: 'type', target: 'Email', value: 'a@b.com', description: '' }, 'Enter "a@b.com" into "Email"'],
    [{ order: 1, action: 'click', target: 'Save', description: '' }, 'Click "Save"'],
    [{ order: 1, action: 'verify', expectedOutcome: 'a toast appears', description: '' }, 'Verify a toast appears'],
  ];
  it.each(cases)('renders %o as a readable instruction', (step, expected) => {
    expect(stepToInstruction(step)).toBe(expected);
  });
});

describe('projectFlowToTestCases', () => {
  it('projects one canonical test linked to the source flow, with type from coverage', () => {
    const f = flow({
      name: 'Validation: Login rejects empty submit',
      coverageType: 'validation',
      startUrl: 'https://app/login',
      steps: [
        { order: 2, action: 'click', target: 'Submit', selector: '#submit', description: 'submit' },
        { order: 1, action: 'navigate', value: 'https://app/login', description: 'open' },
      ],
    });
    const [tc] = projectFlowToTestCases(f);
    expect(tc.type).toBe('negative');
    expect(tc.sourceFlowId).toBe('f1');
    expect(tc.source).toBe('generated');
    expect(tc.startUrl).toBe('https://app/login');
    // Steps are ordered by `order`, then serialized.
    expect(tc.steps).toEqual(['Navigate to https://app/login', 'Click "Submit"']);
  });

  it('appends a doc citation to the description when the flow is grounded', () => {
    const f = flow({
      description: 'Open the transcript.',
      coverageType: 'exploratory',
      knowledgeRefs: [{ url: 'https://help/x', section: 'Transcript view', score: 0.8 }],
      steps: [{ order: 1, action: 'navigate', value: 'https://app/r?tab=transcript', description: 'open' }],
    });
    const [tc] = projectFlowToTestCases(f);
    expect(tc.description).toContain('Grounded in docs');
    expect(tc.description).toContain('Transcript view');
  });

  it('returns nothing for a flow with no steps', () => {
    expect(projectFlowToTestCases(flow({ steps: [] }))).toHaveLength(0);
  });
});

describe('projectFlowToTestCases preplan (verbatim CDP execution)', () => {
  it('builds a verbatim execution plan when every step is grounded', () => {
    const f = flow({
      coverageType: 'happy',
      steps: [
        { order: 1, action: 'navigate', value: 'https://app/login', description: 'open' },
        { order: 2, action: 'type', selector: '#email', target: 'Email', value: 'a@b.com', description: '' },
        { order: 3, action: 'click', selector: '#submit', target: 'Submit', description: '' },
        { order: 4, action: 'verify', target: 'Dashboard', description: '' },
      ],
    });
    const [tc] = projectFlowToTestCases(f);
    expect(tc.preplan).toBeDefined();
    expect(tc.preplan!.map((s) => s.action)).toEqual(['navigate', 'type', 'click', 'assert']);
    // Captured selectors are carried VERBATIM — not re-derived.
    expect(tc.preplan![1]).toMatchObject({ action: 'type', selector: '#email', value: 'a@b.com' });
    expect(tc.preplan![2]).toMatchObject({ action: 'click', selector: '#submit' });
    // The verify step becomes a text assertion (no selector needed).
    expect(tc.preplan![3]).toMatchObject({ action: 'assert', assertType: 'text', assertExpected: 'Dashboard' });
  });

  it('omits the preplan when an action step has no captured selector (→ LLM fallback)', () => {
    const f = flow({
      steps: [
        { order: 1, action: 'navigate', value: 'https://app/x', description: 'open' },
        { order: 2, action: 'click', target: 'Submit', description: '' }, // no selector
      ],
    });
    const [tc] = projectFlowToTestCases(f);
    expect(tc.preplan).toBeUndefined();
    // Steps + confidence are still produced for display.
    expect(tc.steps!.length).toBe(2);
  });

  it('maps a page-url verify to a url assertion', () => {
    const f = flow({
      steps: [
        { order: 1, action: 'navigate', value: 'https://app/x', description: '' },
        { order: 2, action: 'verify', target: 'page-url', value: 'https://app/x', description: '' },
      ],
    });
    const [tc] = projectFlowToTestCases(f);
    expect(tc.preplan![1]).toMatchObject({ action: 'assert', assertType: 'url', assertExpected: 'https://app/x' });
  });
});
