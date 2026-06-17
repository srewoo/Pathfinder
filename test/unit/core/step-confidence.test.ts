import { describe, it, expect } from 'vitest';
import { confidenceFromFlowStep, confidenceFromText } from '../../../src/core/test-gen/step-confidence';
import { projectFlowToTestCases } from '../../../src/core/test-gen/flow-projection';
import type { Flow, FlowStep } from '../../../src/storage/schemas';

describe('confidenceFromFlowStep', () => {
  it('marks a step with a captured selector as grounded', () => {
    expect(confidenceFromFlowStep({ order: 1, action: 'click', selector: '#save', description: '' }, false)).toBe('grounded');
  });
  it('marks a navigate-to-URL as grounded (from the explored graph)', () => {
    expect(confidenceFromFlowStep({ order: 1, action: 'navigate', value: 'https://app/x', description: '' }, false)).toBe('grounded');
  });
  it('marks an assertion as doc_asserted when the flow has knowledge, else inferred', () => {
    const verify: FlowStep = { order: 1, action: 'verify', target: 'toast', description: '' };
    expect(confidenceFromFlowStep(verify, true)).toBe('doc_asserted');
    expect(confidenceFromFlowStep(verify, false)).toBe('inferred');
  });
  it('marks a selector-less click as inferred', () => {
    expect(confidenceFromFlowStep({ order: 1, action: 'click', target: 'Save', description: '' }, true)).toBe('inferred');
  });
});

describe('confidenceFromText (LLM string steps)', () => {
  it('treats assertion verbs as doc_asserted only when knowledge exists', () => {
    expect(confidenceFromText('Verify the success toast appears', true)).toBe('doc_asserted');
    expect(confidenceFromText('Verify the success toast appears', false)).toBe('inferred');
  });
  it('treats action verbs as inferred regardless of knowledge', () => {
    expect(confidenceFromText('Click the Save button', true)).toBe('inferred');
    expect(confidenceFromText('Enter "a@b.com" into Email', true)).toBe('inferred');
  });
});

describe('projectFlowToTestCases attaches aligned stepConfidence', () => {
  it('produces one confidence per step, grounded for captured selectors', () => {
    const flow: Flow = {
      flowId: 'f', name: 'Submit form: Login', description: '', source: 'exploration',
      coverageType: 'happy', startUrl: 'https://app/login',
      knowledgeRefs: [{ url: 'https://help/login', section: 'Sign in', score: 0.7 }],
      steps: [
        { order: 1, action: 'navigate', value: 'https://app/login', description: 'open' },
        { order: 2, action: 'type', selector: '#email', target: 'Email', value: 'a@b.com', description: '' },
        { order: 3, action: 'click', target: 'Submit', description: '' }, // no selector → inferred
        { order: 4, action: 'verify', target: 'dashboard', description: '' }, // assertion + knowledge → doc_asserted
      ],
      createdAt: '', updatedAt: '',
    };
    const [tc] = projectFlowToTestCases(flow);
    expect(tc.stepConfidence).toEqual(['grounded', 'grounded', 'inferred', 'doc_asserted']);
    expect(tc.stepConfidence!.length).toBe(tc.steps!.length);
  });
});
