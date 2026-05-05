import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all dependencies
vi.mock('../../../src/core/knowledge/vector-search', () => ({
  searchByText: vi.fn().mockResolvedValue([]),
  formatSearchResults: vi.fn().mockReturnValue('No docs.'),
}));
vi.mock('../../../src/core/explorer/interaction-graph', () => ({
  loadGraph: vi.fn().mockResolvedValue(null),
  serializeGraphForAI: vi.fn().mockReturnValue('No graph.'),
  extractFormFieldsStructured: vi.fn().mockReturnValue('No fields.'),
  serializeNavigationMap: vi.fn().mockReturnValue('No nav.'),
}));
vi.mock('../../../src/core/flow/flow-store', () => ({
  getAllFlows: vi.fn().mockResolvedValue([]),
  serializeFlowsForAI: vi.fn().mockReturnValue('No flows.'),
}));
vi.mock('../../../src/storage/indexed-db', () => ({
  testCaseDB: { put: vi.fn(), get: vi.fn(), getAll: vi.fn().mockResolvedValue([]) },
  planDB: { getAll: vi.fn().mockResolvedValue([]), delete: vi.fn() },
  vectorDB: { put: vi.fn() },
}));
vi.mock('../../../src/storage/chrome-storage', () => ({
  executionPresetStorage: { getById: vi.fn().mockResolvedValue(null), getAll: vi.fn().mockResolvedValue([]) },
}));

import { expandImportedTests } from '../../../src/core/test-gen/test-importer';
import type { ImportedTestCase } from '../../../src/core/test-gen/test-importer';

function makeMockAIClient(response: string) {
  return {
    chat: vi.fn().mockResolvedValue(response),
    embed: vi.fn().mockResolvedValue([[0.1, 0.2]]),
  };
}

describe('Test Expansion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should parse standard JSON response with steps', async () => {
    const aiClient = makeMockAIClient(JSON.stringify({
      title: 'User can create DSR room',
      description: 'Verify the DSR room creation flow',
      type: 'positive',
      startUrl: 'https://app.com/rooms',
      steps: [
        'Navigate to https://app.com/rooms',
        "Click the 'Create Room' button",
        "Type 'Test Room' into the Name field",
        'Click Submit',
        'Verify success message appears',
      ],
    }));

    const tests: ImportedTestCase[] = [{ title: 'User can create DSR room' }];
    const result = await expandImportedTests(tests, aiClient as any);

    expect(result).toHaveLength(1);
    expect(result[0].steps.length).toBeGreaterThanOrEqual(4);
    expect(result[0].steps[0]).toContain('Navigate');
  });

  it('should handle wrapped response { "test": {...} }', async () => {
    const aiClient = makeMockAIClient(JSON.stringify({
      test: {
        title: 'Login test',
        description: 'Test login flow',
        type: 'positive',
        steps: ['Navigate to login', 'Enter email', 'Enter password', 'Click login', 'Verify dashboard'],
      },
    }));

    const tests: ImportedTestCase[] = [{ title: 'Login test' }];
    const result = await expandImportedTests(tests, aiClient as any);

    expect(result[0].steps.length).toBeGreaterThanOrEqual(4);
  });

  it('should handle object-format steps [{ "description": "..." }]', async () => {
    const aiClient = makeMockAIClient(JSON.stringify({
      title: 'Create project',
      description: 'Create a new project',
      type: 'positive',
      steps: [
        { step: 1, description: 'Navigate to projects page' },
        { step: 2, description: 'Click Create button' },
        { step: 3, description: 'Fill in project name' },
        { step: 4, description: 'Click Save' },
        { step: 5, description: 'Verify success' },
      ],
    }));

    const tests: ImportedTestCase[] = [{ title: 'Create project' }];
    const result = await expandImportedTests(tests, aiClient as any);

    expect(result[0].steps).toHaveLength(5);
    expect(result[0].steps[0]).toBe('Navigate to projects page');
  });

  it('should handle alternative step key names (testSteps)', async () => {
    const aiClient = makeMockAIClient(JSON.stringify({
      title: 'Delete item',
      description: 'Delete an item',
      type: 'negative',
      testSteps: ['Navigate to items', 'Select item', 'Click Delete', 'Confirm', 'Verify deleted'],
    }));

    const tests: ImportedTestCase[] = [{ title: 'Delete item' }];
    const result = await expandImportedTests(tests, aiClient as any);

    expect(result[0].steps).toHaveLength(5);
  });

  it('should generate fallback steps when AI returns no steps', async () => {
    const aiClient = makeMockAIClient(JSON.stringify({
      title: 'User can create DSR room',
      description: 'Create a room',
      type: 'positive',
      // No steps field at all
    }));

    const tests: ImportedTestCase[] = [{ title: 'User can create DSR room', startUrl: 'https://app.com' }];
    const result = await expandImportedTests(tests, aiClient as any);

    // Should have fallback steps, not empty
    expect(result[0].steps.length).toBeGreaterThan(0);
    expect(result[0].steps.some((s) => s.toLowerCase().includes('create') || s.toLowerCase().includes('navigate'))).toBe(true);
  });

  it('should generate fallback steps with correct intent for "create" tests', async () => {
    // Simulate total AI failure
    const aiClient = {
      chat: vi.fn().mockRejectedValue(new Error('API timeout')),
      embed: vi.fn().mockResolvedValue([[0.1]]),
    };

    const tests: ImportedTestCase[] = [{ title: 'Admin can create a new project', startUrl: 'https://app.com/projects' }];
    const result = await expandImportedTests(tests, aiClient as any);

    expect(result[0].steps.length).toBeGreaterThanOrEqual(3);
    expect(result[0].steps[0]).toContain('https://app.com/projects');
    expect(result[0].steps.some((s) => s.toLowerCase().includes('create') || s.toLowerCase().includes('add'))).toBe(true);
  });

  it('should generate fallback steps for "login" tests', async () => {
    const aiClient = {
      chat: vi.fn().mockRejectedValue(new Error('fail')),
      embed: vi.fn().mockResolvedValue([[0.1]]),
    };

    const tests: ImportedTestCase[] = [{ title: 'User can login with valid credentials' }];
    const result = await expandImportedTests(tests, aiClient as any);

    expect(result[0].steps.some((s) => s.toLowerCase().includes('username') || s.toLowerCase().includes('email'))).toBe(true);
    expect(result[0].steps.some((s) => s.toLowerCase().includes('password'))).toBe(true);
  });

  it('should generate negative test fallback with error assertion', async () => {
    const aiClient = {
      chat: vi.fn().mockRejectedValue(new Error('fail')),
      embed: vi.fn().mockResolvedValue([[0.1]]),
    };

    const tests: ImportedTestCase[] = [{ title: 'Cannot submit empty form', type: 'negative' }];
    const result = await expandImportedTests(tests, aiClient as any);

    expect(result[0].type).toBe('negative');
    expect(result[0].steps.some((s) => s.toLowerCase().includes('error'))).toBe(true);
  });

  it('should handle malformed JSON gracefully', async () => {
    const aiClient = makeMockAIClient('This is not JSON at all, just plain text about testing.');

    const tests: ImportedTestCase[] = [{ title: 'Some test' }];
    const result = await expandImportedTests(tests, aiClient as any);

    // Should return fallback, not crash
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Some test');
    expect(result[0].steps.length).toBeGreaterThan(0);
  });

  it('should handle markdown-wrapped JSON', async () => {
    const json = JSON.stringify({
      title: 'Edit user',
      description: 'Edit a user profile',
      type: 'positive',
      steps: ['Navigate to users', 'Click Edit', 'Change name', 'Save', 'Verify updated'],
    });
    const aiClient = makeMockAIClient('```json\n' + json + '\n```');

    const tests: ImportedTestCase[] = [{ title: 'Edit user' }];
    const result = await expandImportedTests(tests, aiClient as any);

    expect(result[0].steps).toHaveLength(5);
  });

  it('should preserve user-provided steps if AI returns fewer', async () => {
    const aiClient = makeMockAIClient(JSON.stringify({
      title: 'Test with steps',
      description: 'Test',
      type: 'positive',
      steps: [], // AI returned empty
    }));

    const userSteps = ['Step 1: Do this', 'Step 2: Do that', 'Step 3: Verify'];
    const tests: ImportedTestCase[] = [{ title: 'Test with steps', steps: userSteps }];
    const result = await expandImportedTests(tests, aiClient as any);

    // Should use user's steps as fallback since AI returned empty
    expect(result[0].steps.length).toBeGreaterThan(0);
  });
});
