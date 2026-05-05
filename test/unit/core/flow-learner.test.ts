import { describe, it, expect } from 'vitest';
import { inferFlowStartDetails, inferFlowStartUrl } from '../../../src/core/flow/flow-learner';
import type { InteractionGraph, Flow } from '../../../src/storage/schemas';

function makeGraph(): InteractionGraph {
  return {
    nodes: [
      {
        id: 'home',
        url: 'https://app.example.com/dashboard',
        title: 'Dashboard',
        visitedAt: new Date().toISOString(),
        elementCount: 5,
      },
      {
        id: 'projects',
        url: 'https://app.example.com/projects',
        title: 'Projects',
        visitedAt: new Date().toISOString(),
        elementCount: 8,
      },
      {
        id: 'create-project',
        url: 'https://app.example.com/projects/new',
        title: 'Create Project',
        visitedAt: new Date().toISOString(),
        elementCount: 10,
      },
    ],
    edges: [
      {
        from: 'https://app.example.com/dashboard',
        to: 'https://app.example.com/projects',
        action: 'click',
        selector: '[data-testid="projects-nav"]',
        label: 'Projects',
      },
      {
        from: 'https://app.example.com/projects',
        to: 'https://app.example.com/projects/new',
        action: 'click',
        selector: '[data-testid="create-project"]',
        label: 'Create Project',
      },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeFlow(partial: Partial<Flow> = {}): Flow {
  return {
    flowId: 'flow-1',
    name: 'Create Project',
    description: 'Create a new project from the projects area.',
    steps: [
      {
        order: 1,
        action: 'click',
        target: 'Create Project',
        description: 'Click the Create Project button',
      },
      {
        order: 2,
        action: 'type',
        target: 'Project name',
        value: 'Apollo',
        description: 'Enter the project name',
      },
    ],
    source: 'exploration',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...partial,
  };
}

describe('inferFlowStartUrl', () => {
  it('prefers the page whose outgoing edge matches the first actionable step', () => {
    const startUrl = inferFlowStartUrl(makeGraph(), makeFlow());
    expect(startUrl).toBe('https://app.example.com/projects');
  });

  it('returns confidence metadata and a human-readable reason', () => {
    const details = inferFlowStartDetails(makeGraph(), makeFlow());

    expect(details?.url).toBe('https://app.example.com/projects');
    expect(details?.inference.method).toBe('edge_match');
    expect(details?.inference.confidence).toBe('high');
    expect(details?.inference.reason).toContain('Create Project');
  });

  it('uses an explicit navigate step when it matches an explored page', () => {
    const startUrl = inferFlowStartUrl(
      makeGraph(),
      makeFlow({
        steps: [
          {
            order: 1,
            action: 'navigate',
            value: 'https://app.example.com/projects',
            description: 'Open projects',
          },
          {
            order: 2,
            action: 'click',
            target: 'Create Project',
            description: 'Click the Create Project button',
          },
        ],
      })
    );

    expect(startUrl).toBe('https://app.example.com/projects');
  });

  it('falls back to page-title matching when no edge strongly matches', () => {
    const startUrl = inferFlowStartUrl(
      makeGraph(),
      makeFlow({
        name: 'Open Dashboard Widgets',
        description: 'Review the widgets on the dashboard.',
        steps: [
          {
            order: 1,
            action: 'assert',
            target: 'Dashboard widgets',
            description: 'Verify the dashboard widgets are visible',
          },
        ],
      })
    );

    expect(startUrl).toBe('https://app.example.com/dashboard');
  });
});
