import { describe, expect, it } from 'vitest';
import { assessExecutionPreflight, looksLikeLoginSurface, resolveStartUrl } from '../../../src/core/executor/preflight';
import type { PageSnapshot, TestCase } from '../../../src/storage/schemas';

function makeSnapshot(partial: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: 'https://app.example.com/login',
    title: 'Sign in',
    elements: [
      {
        selector: '#email',
        tag: 'input',
        type: 'email',
        visible: true,
        position: { x: 0, y: 0, width: 100, height: 20 },
      },
      {
        selector: '#password',
        tag: 'input',
        type: 'password',
        visible: true,
        position: { x: 0, y: 30, width: 100, height: 20 },
      },
      {
        selector: 'button[type="submit"]',
        tag: 'button',
        text: 'Sign in',
        visible: true,
        position: { x: 0, y: 60, width: 100, height: 20 },
      },
    ],
    domCompressed: '<form></form>',
    capturedAt: new Date().toISOString(),
    ...partial,
  };
}

function makeTestCase(partial: Partial<TestCase> = {}): TestCase {
  return {
    id: 'tc-1',
    title: 'Create project',
    description: 'Creates a new project',
    type: 'positive',
    source: 'user',
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

describe('assessExecutionPreflight', () => {
  it('blocks unsupported active-tab URLs', () => {
    const result = assessExecutionPreflight({
      activeTabId: 1,
      activeTabUrl: 'chrome://extensions',
      contentScriptReady: false,
      testCases: [makeTestCase()],
    });

    expect(result.ok).toBe(false);
    expect(result.blockers.some((issue) => issue.code === 'unsupported_url')).toBe(true);
  });

  it('blocks when the content script is unreachable on an otherwise valid page', () => {
    const result = assessExecutionPreflight({
      activeTabId: 1,
      activeTabUrl: 'https://app.example.com/dashboard',
      contentScriptReady: false,
      testCases: [makeTestCase()],
    });

    expect(result.ok).toBe(false);
    expect(result.blockers.some((issue) => issue.code === 'content_script_unreachable')).toBe(true);
  });

  it('blocks invalid start URLs', () => {
    const result = assessExecutionPreflight({
      activeTabId: 1,
      activeTabUrl: 'https://app.example.com/dashboard',
      contentScriptReady: true,
      testCases: [makeTestCase({ startUrl: 'chrome://settings' })],
    });

    expect(result.ok).toBe(false);
    expect(result.blockers.some((issue) => issue.code === 'invalid_start_url')).toBe(true);
  });

  it('blocks tests without start URLs when the current page looks like login', () => {
    const result = assessExecutionPreflight({
      activeTabId: 1,
      activeTabUrl: 'https://app.example.com/login',
      contentScriptReady: true,
      snapshot: makeSnapshot(),
      testCases: [makeTestCase()],
    });

    expect(result.ok).toBe(false);
    expect(result.blockers.some((issue) => issue.code === 'login_page_without_start_url')).toBe(true);
  });

  it('allows execution but warns when app tests start from a login-like current tab', () => {
    const result = assessExecutionPreflight({
      activeTabId: 1,
      activeTabUrl: 'https://app.example.com/login',
      contentScriptReady: true,
      snapshot: makeSnapshot(),
      testCases: [makeTestCase({ startUrl: 'https://app.example.com/projects' })],
    });

    expect(result.ok).toBe(true);
    expect(result.warnings.some((issue) => issue.code === 'login_page_warning')).toBe(true);
  });

  it('warns when a test starts on a different origin', () => {
    const result = assessExecutionPreflight({
      activeTabId: 1,
      activeTabUrl: 'https://staging.example.com/dashboard',
      contentScriptReady: true,
      testCases: [makeTestCase({ startUrl: 'https://prod.example.com/projects' })],
    });

    expect(result.ok).toBe(true);
    expect(result.warnings.some((issue) => issue.code === 'cross_origin_start_url')).toBe(true);
  });
});

describe('preflight helpers', () => {
  it('detects login surfaces from page signals', () => {
    expect(looksLikeLoginSurface(makeSnapshot())).toBe(true);
  });

  it('resolves relative start URLs against the current tab URL', () => {
    expect(resolveStartUrl('/projects/new', 'https://app.example.com/dashboard')).toBe(
      'https://app.example.com/projects/new'
    );
  });
});
