import type { PageSnapshot, TestCase } from '../../storage/schemas';
import { getPageSnapshot } from '../explorer/page-scanner';
import { pingContentScript } from '../../messaging/messenger';

const LOGIN_KEYWORDS = [
  'login',
  'log in',
  'sign in',
  'signin',
  'authenticate',
  'authentication',
  'password',
  'forgot password',
  'two-factor',
  '2fa',
  'otp',
  'verify code',
];

export interface ExecutionPreflightIssue {
  code:
    | 'no_active_tab'
    | 'unsupported_url'
    | 'content_script_unreachable'
    | 'invalid_start_url'
    | 'login_page_without_start_url'
    | 'login_page_warning'
    | 'cross_origin_start_url';
  message: string;
  severity: 'blocker' | 'warning';
  testCaseId?: string;
}

export interface ExecutionPreflightResult {
  ok: boolean;
  blockers: ExecutionPreflightIssue[];
  warnings: ExecutionPreflightIssue[];
  activeTabId?: number;
  activeTabUrl?: string;
}

interface AssessExecutionPreflightInput {
  activeTabId?: number;
  activeTabUrl?: string;
  contentScriptReady: boolean;
  snapshot?: Pick<PageSnapshot, 'url' | 'title' | 'elements'> | null;
  testCases: Pick<
    TestCase,
    'id' | 'title' | 'startUrl' | 'requiresAuthenticatedSession' | 'executionPresetName' | 'personaLabel'
  >[];
}

export async function validateExecutionPreflight(
  testCases: Pick<
    TestCase,
    'id' | 'title' | 'startUrl' | 'requiresAuthenticatedSession' | 'executionPresetName' | 'personaLabel'
  >[]
): Promise<ExecutionPreflightResult> {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTabId = activeTab?.id;
  const activeTabUrl = activeTab?.url;

  if (!activeTabId) {
    return {
      ok: false,
      blockers: [
        {
          code: 'no_active_tab',
          severity: 'blocker',
          message: 'Open the application in an active browser tab before running tests.',
        },
      ],
      warnings: [],
    };
  }

  if (!isSupportedTabUrl(activeTabUrl)) {
    return {
      ok: false,
      blockers: [
        {
          code: 'unsupported_url',
          severity: 'blocker',
          message: 'pathfinder can only run tests on regular http(s) pages. Open the app in a normal browser tab and try again.',
        },
      ],
      warnings: [],
      activeTabId,
      activeTabUrl,
    };
  }

  const contentScriptReady = await pingContentScript(activeTabId);
  const snapshot = contentScriptReady ? await getPageSnapshot(activeTabId) : null;

  return assessExecutionPreflight({
    activeTabId,
    activeTabUrl,
    contentScriptReady,
    snapshot,
    testCases,
  });
}

export function assessExecutionPreflight(
  input: AssessExecutionPreflightInput
): ExecutionPreflightResult {
  const blockers: ExecutionPreflightIssue[] = [];
  const warnings: ExecutionPreflightIssue[] = [];

  if (!input.activeTabId) {
    blockers.push({
      code: 'no_active_tab',
      severity: 'blocker',
      message: 'Open the application in an active browser tab before running tests.',
    });
  }

  if (!isSupportedTabUrl(input.activeTabUrl)) {
    blockers.push({
      code: 'unsupported_url',
      severity: 'blocker',
      message: 'pathfinder can only run tests on regular http(s) pages. Open the app in a normal browser tab and try again.',
    });
  }

  if (input.activeTabId && isSupportedTabUrl(input.activeTabUrl) && !input.contentScriptReady) {
    blockers.push({
      code: 'content_script_unreachable',
      severity: 'blocker',
      message: 'pathfinder cannot reach the page automation agent on this tab. Refresh the page or reopen the app before running tests.',
    });
  }

  const activeOrigin = getOrigin(input.activeTabUrl);

  for (const testCase of input.testCases) {
    if (!testCase.startUrl) continue;

    const resolvedStartUrl = resolveStartUrl(testCase.startUrl, input.activeTabUrl);
    if (!resolvedStartUrl || !isSupportedTabUrl(resolvedStartUrl)) {
      blockers.push({
        code: 'invalid_start_url',
        severity: 'blocker',
        testCaseId: testCase.id,
        message: `"${testCase.title}" has an invalid start URL. Edit the test before running it again.`,
      });
      continue;
    }

    if (activeOrigin && getOrigin(resolvedStartUrl) !== activeOrigin) {
      warnings.push({
        code: 'cross_origin_start_url',
        severity: 'warning',
        testCaseId: testCase.id,
        message: `"${testCase.title}" starts on a different origin than the current tab. pathfinder will navigate there, but you should confirm the target environment and session are correct.`,
      });
    }
  }

  const authSurface = looksLikeLoginSurface(input.snapshot ?? undefined);
  if (authSurface) {
    const testsWithoutStartUrl = input.testCases.filter((testCase) => !testCase.startUrl);
    if (testsWithoutStartUrl.length > 0) {
      blockers.push({
        code: 'login_page_without_start_url',
        severity: 'blocker',
        message:
          testsWithoutStartUrl.length === 1
            ? `"${testsWithoutStartUrl[0].title}" has no start URL, but the current page looks like a login screen. Set a start URL or navigate to the correct in-app page first.`
            : `${testsWithoutStartUrl.length} selected tests have no start URL, and the current page looks like a login screen. Set start URLs or navigate to the correct in-app page first.`,
      });
    }

    const appTests = input.testCases.filter(
      (testCase) => testCase.startUrl && !looksLikeLoginUrl(testCase.startUrl)
    );
    if (appTests.length > 0) {
      const authSensitiveTests = appTests.filter((testCase) => testCase.requiresAuthenticatedSession);
      warnings.push({
        code: 'login_page_warning',
        severity: 'warning',
        message:
          authSensitiveTests.length > 0
            ? `The current tab still looks like a login or authentication page. ${authSensitiveTests.length} selected test${authSensitiveTests.length === 1 ? '' : 's'} require an authenticated session and may fail until that session is established.`
            : 'The current tab looks like a login or authentication page. Tests with app start URLs may still run, but they can fail if the required session is not established yet.',
      });
    }
  }

  return {
    ok: blockers.length === 0,
    blockers,
    warnings: dedupeIssues(warnings),
    activeTabId: input.activeTabId,
    activeTabUrl: input.activeTabUrl,
  };
}

export function summarizePreflightIssues(issues: ExecutionPreflightIssue[]): string[] {
  return dedupeIssues(issues).map((issue) => issue.message);
}

export function resolveStartUrl(startUrl: string, baseUrl?: string): string | null {
  try {
    return new URL(startUrl, baseUrl).toString();
  } catch {
    return null;
  }
}

export function looksLikeLoginSurface(
  snapshot?: Pick<PageSnapshot, 'url' | 'title' | 'elements'> | null
): boolean {
  if (!snapshot) return false;

  const pageSignals = [
    snapshot.title,
    snapshot.url,
    ...snapshot.elements.flatMap((element) => [element.text, element.ariaLabel, element.type]),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const passwordFieldCount = snapshot.elements.filter((element) => element.type === 'password').length;
  const keywordHits = LOGIN_KEYWORDS.filter((keyword) => pageSignals.includes(keyword)).length;

  return passwordFieldCount > 0 || keywordHits >= 2 || looksLikeLoginUrl(snapshot.url);
}

export function looksLikeLoginUrl(url?: string): boolean {
  if (!url) return false;
  const lowerUrl = url.toLowerCase();
  return ['login', 'signin', 'sign-in', 'auth', 'password', 'verify'].some((fragment) =>
    lowerUrl.includes(fragment)
  );
}

function isSupportedTabUrl(url?: string): boolean {
  return Boolean(url && /^https?:\/\//i.test(url));
}

function getOrigin(url?: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function dedupeIssues(issues: ExecutionPreflightIssue[]): ExecutionPreflightIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.code}:${issue.testCaseId ?? ''}:${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
