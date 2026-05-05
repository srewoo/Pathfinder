import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock CDP client
vi.mock('../../../src/core/cdp/cdp-client', () => ({
  getAccessibilityTree: vi.fn(),
  isAttached: vi.fn(),
  evaluate: vi.fn(),
}));

import { runAccessibilityAudit, formatA11yReport } from '../../../src/core/analysis/accessibility-audit';
import { getAccessibilityTree, isAttached, evaluate } from '../../../src/core/cdp/cdp-client';
import type { AXNode } from '../../../src/core/cdp/cdp-client';

const mockedIsAttached = vi.mocked(isAttached);
const mockedGetAXTree = vi.mocked(getAccessibilityTree);
const mockedEvaluate = vi.mocked(evaluate);

function makeAXNode(overrides: Partial<AXNode> = {}): AXNode {
  return {
    nodeId: '1',
    role: { type: 'role', value: 'generic' },
    ...overrides,
  };
}

describe('Accessibility Audit', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedEvaluate.mockResolvedValue({} as any);
  });

  it('should skip audit when CDP is not attached', async () => {
    mockedIsAttached.mockReturnValue(false);

    const result = await runAccessibilityAudit(1, 'https://app.com', 'Home');
    expect(result.issues).toHaveLength(0);
    expect(result.url).toBe('https://app.com');
  });

  it('should return empty issues for a clean AX tree', async () => {
    mockedIsAttached.mockReturnValue(true);
    mockedGetAXTree.mockResolvedValue([
      makeAXNode({
        role: { type: 'role', value: 'button' },
        name: { type: 'computedString', value: 'Submit' },
      }),
    ]);

    const result = await runAccessibilityAudit(1, 'https://app.com', 'Home');
    // Only DOM checks might add issues, but those are mocked to return empty
    const axIssues = result.issues.filter((i) => !i.ruleId.endsWith('-dom'));
    expect(axIssues).toHaveLength(0);
  });

  it('should flag buttons without accessible name', async () => {
    mockedIsAttached.mockReturnValue(true);
    mockedGetAXTree.mockResolvedValue([
      makeAXNode({
        role: { type: 'role', value: 'button' },
        // No name — this is the issue
      }),
    ]);

    const result = await runAccessibilityAudit(1, 'https://app.com', 'Home');
    const nameIssues = result.issues.filter((i) => i.ruleId === 'missing-accessible-name');
    expect(nameIssues.length).toBeGreaterThan(0);
    expect(nameIssues[0].severity).toBe('serious');
    expect(nameIssues[0].role).toBe('button');
  });

  it('should flag images without alt text as critical', async () => {
    mockedIsAttached.mockReturnValue(true);
    mockedGetAXTree.mockResolvedValue([
      makeAXNode({
        role: { type: 'role', value: 'img' },
        // No name — missing alt text
      }),
    ]);

    const result = await runAccessibilityAudit(1, 'https://app.com', 'Home');
    const imgIssues = result.issues.filter((i) => i.ruleId === 'image-missing-alt');
    expect(imgIssues.length).toBeGreaterThan(0);
    expect(imgIssues[0].severity).toBe('critical');
    expect(imgIssues[0].wcag).toContain('1.1.1');
  });

  it('should flag empty headings', async () => {
    mockedIsAttached.mockReturnValue(true);
    mockedGetAXTree.mockResolvedValue([
      makeAXNode({
        role: { type: 'role', value: 'heading' },
        name: { type: 'computedString', value: '' },
      }),
    ]);

    const result = await runAccessibilityAudit(1, 'https://app.com', 'Home');
    const headingIssues = result.issues.filter((i) => i.ruleId === 'empty-heading');
    expect(headingIssues.length).toBeGreaterThan(0);
    expect(headingIssues[0].severity).toBe('moderate');
  });

  it('should flag invalid role-children relationships', async () => {
    mockedIsAttached.mockReturnValue(true);
    mockedGetAXTree.mockResolvedValue([
      makeAXNode({
        role: { type: 'role', value: 'list' },
        name: { type: 'computedString', value: 'Nav' },
        children: [
          // Should have listitem children, but has button instead
          makeAXNode({
            role: { type: 'role', value: 'button' },
            name: { type: 'computedString', value: 'Click' },
          }),
        ],
      }),
    ]);

    const result = await runAccessibilityAudit(1, 'https://app.com', 'Home');
    const childIssues = result.issues.filter((i) => i.ruleId === 'invalid-role-children');
    expect(childIssues.length).toBeGreaterThan(0);
    expect(childIssues[0].message).toContain('listitem');
  });

  it('should not flag valid role-children relationships', async () => {
    mockedIsAttached.mockReturnValue(true);
    mockedGetAXTree.mockResolvedValue([
      makeAXNode({
        role: { type: 'role', value: 'list' },
        name: { type: 'computedString', value: 'Nav' },
        children: [
          makeAXNode({
            role: { type: 'role', value: 'listitem' },
            name: { type: 'computedString', value: 'Item 1' },
          }),
        ],
      }),
    ]);

    const result = await runAccessibilityAudit(1, 'https://app.com', 'Home');
    const childIssues = result.issues.filter((i) => i.ruleId === 'invalid-role-children');
    expect(childIssues).toHaveLength(0);
  });

  it('should flag disabled state on non-interactive elements', async () => {
    mockedIsAttached.mockReturnValue(true);
    mockedGetAXTree.mockResolvedValue([
      makeAXNode({
        role: { type: 'role', value: 'paragraph' },
        name: { type: 'computedString', value: 'Some text' },
        properties: [
          { name: 'disabled', value: { type: 'boolean', value: true } },
        ],
      }),
    ]);

    const result = await runAccessibilityAudit(1, 'https://app.com', 'Home');
    const disabledIssues = result.issues.filter((i) => i.ruleId === 'disabled-non-interactive');
    expect(disabledIssues.length).toBeGreaterThan(0);
    expect(disabledIssues[0].severity).toBe('minor');
  });

  it('should NOT flag disabled state on interactive elements', async () => {
    mockedIsAttached.mockReturnValue(true);
    mockedGetAXTree.mockResolvedValue([
      makeAXNode({
        role: { type: 'role', value: 'button' },
        name: { type: 'computedString', value: 'Submit' },
        properties: [
          { name: 'disabled', value: { type: 'boolean', value: true } },
        ],
      }),
    ]);

    const result = await runAccessibilityAudit(1, 'https://app.com', 'Home');
    const disabledIssues = result.issues.filter((i) => i.ruleId === 'disabled-non-interactive');
    expect(disabledIssues).toHaveLength(0);
  });

  it('should skip ignored/presentation roles', async () => {
    mockedIsAttached.mockReturnValue(true);
    mockedGetAXTree.mockResolvedValue([
      makeAXNode({ role: { type: 'role', value: 'none' } }),
      makeAXNode({ role: { type: 'role', value: 'presentation' } }),
    ]);

    const result = await runAccessibilityAudit(1, 'https://app.com', 'Home');
    // None/presentation roles should be skipped entirely
    const axIssues = result.issues.filter((i) =>
      i.ruleId === 'missing-accessible-name' || i.ruleId === 'image-missing-alt'
    );
    expect(axIssues).toHaveLength(0);
  });

  it('should handle DOM evaluate returning empty gracefully', async () => {
    mockedIsAttached.mockReturnValue(true);
    mockedGetAXTree.mockResolvedValue([]);
    // evaluate returns empty/error — DOM checks should not crash
    mockedEvaluate.mockResolvedValue({} as any);

    const result = await runAccessibilityAudit(1, 'https://app.com', 'Home');
    // Should complete without errors even if DOM checks find nothing
    expect(result.url).toBe('https://app.com');
  });

  it('should compute correct summary counts', async () => {
    mockedIsAttached.mockReturnValue(true);
    mockedGetAXTree.mockResolvedValue([
      makeAXNode({ role: { type: 'role', value: 'img' } }), // critical: missing alt
      makeAXNode({ role: { type: 'role', value: 'button' } }), // serious: missing name
      makeAXNode({ role: { type: 'role', value: 'heading' }, name: { type: 'computedString', value: '' } }), // moderate: empty heading
    ]);

    const result = await runAccessibilityAudit(1, 'https://app.com', 'Home');
    expect(result.summary.critical).toBeGreaterThan(0);
    expect(result.summary.serious).toBeGreaterThan(0);
    expect(result.summary.moderate).toBeGreaterThan(0);
    expect(result.summary.total).toBe(result.issues.length);
  });

  it('should recurse into child nodes', async () => {
    mockedIsAttached.mockReturnValue(true);
    mockedGetAXTree.mockResolvedValue([
      makeAXNode({
        role: { type: 'role', value: 'generic' },
        name: { type: 'computedString', value: 'container' },
        children: [
          makeAXNode({
            role: { type: 'role', value: 'button' },
            // Missing name — nested inside a container
          }),
        ],
      }),
    ]);

    const result = await runAccessibilityAudit(1, 'https://app.com', 'Home');
    const nameIssues = result.issues.filter((i) => i.ruleId === 'missing-accessible-name');
    expect(nameIssues.length).toBeGreaterThan(0);
  });

  it('should handle AX tree fetch failure gracefully', async () => {
    mockedIsAttached.mockReturnValue(true);
    mockedGetAXTree.mockRejectedValue(new Error('CDP disconnected'));

    const result = await runAccessibilityAudit(1, 'https://app.com', 'Home');
    expect(result.issues).toHaveLength(0);
    expect(result.url).toBe('https://app.com');
  });

  describe('formatA11yReport', () => {
    it('should format empty results', () => {
      const report = formatA11yReport([]);
      expect(report).toContain('No issues found');
    });

    it('should format results with issues', async () => {
      mockedIsAttached.mockReturnValue(true);
      mockedGetAXTree.mockResolvedValue([
        makeAXNode({ role: { type: 'role', value: 'img' } }),
      ]);

      const result = await runAccessibilityAudit(1, 'https://app.com', 'Home');
      const report = formatA11yReport([result]);
      expect(report).toContain('Accessibility Audit');
      expect(report).toContain('CRITICAL');
      expect(report).toContain('WCAG');
    });

    it('should include page count and issue breakdown', async () => {
      mockedIsAttached.mockReturnValue(true);
      mockedGetAXTree.mockResolvedValue([
        makeAXNode({ role: { type: 'role', value: 'button' } }),
      ]);

      const r1 = await runAccessibilityAudit(1, 'https://app.com/page1', 'Page 1');
      const r2 = await runAccessibilityAudit(1, 'https://app.com/page2', 'Page 2');
      const report = formatA11yReport([r1, r2]);
      expect(report).toContain('Pages audited:**');
      expect(report).toContain('2');
    });
  });
});
