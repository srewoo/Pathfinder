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
