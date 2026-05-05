import {
  chromium,
  firefox,
  webkit,
  expect,
  type Browser,
  type Page,
} from '@playwright/test';
import type { ExecutionStep, StepResult, TestCase, TestResult } from './types.js';

export type BrowserName = 'chromium' | 'firefox' | 'webkit';

export interface RunnerOptions {
  browser?: BrowserName;
  headless?: boolean;
  timeout?: number;
  baseUrl?: string;
}

export async function launchBrowser(options: RunnerOptions = {}): Promise<Browser> {
  const { browser = 'chromium', headless = true } = options;
  const engine =
    browser === 'firefox' ? firefox : browser === 'webkit' ? webkit : chromium;
  return engine.launch({ headless });
}

export async function executeTestWithPlaywright(
  testCase: TestCase,
  steps: ExecutionStep[],
  browser: Browser,
  options: RunnerOptions = {}
): Promise<TestResult> {
  const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  const startedAt = new Date().toISOString();
  const overallStart = Date.now();

  const page = await browser.newPage();

  // Navigate to the start URL before executing steps
  const startUrl = testCase.startUrl ?? options.baseUrl;
  if (startUrl) {
    try {
      await page.goto(startUrl, { waitUntil: 'networkidle', timeout: options.timeout ?? 30000 });
    } catch (err) {
      await page.close();
      return {
        id,
        testCaseId: testCase.id,
        testCaseTitle: testCase.title,
        status: 'error',
        startedAt,
        completedAt: new Date().toISOString(),
        duration: Date.now() - overallStart,
        steps: [],
        errorMessage: `Failed to navigate to start URL "${startUrl}": ${err instanceof Error ? err.message : String(err)}`,
        runId,
      };
    }
  }

  const stepResults: StepResult[] = [];
  let aborted = false;

  for (const step of steps) {
    if (aborted) {
      stepResults.push({ step, status: 'skipped', duration: 0 });
      continue;
    }

    const result = await executeStep(page, step);
    stepResults.push(result);

    if (result.status === 'failed') {
      aborted = true;
    }
  }

  await page.close();

  const finalStatus: 'passed' | 'failed' | 'error' = aborted ? 'failed' : 'passed';
  const failedStep = stepResults.find((r) => r.status === 'failed');

  return {
    id,
    testCaseId: testCase.id,
    testCaseTitle: testCase.title,
    status: finalStatus,
    startedAt,
    completedAt: new Date().toISOString(),
    duration: Date.now() - overallStart,
    steps: stepResults,
    errorMessage: failedStep?.error,
    runId,
  };
}

async function executeStep(page: Page, step: ExecutionStep): Promise<StepResult> {
  const stepStart = Date.now();

  try {
    await performStep(page, step);
    return {
      step,
      status: 'passed',
      duration: Date.now() - stepStart,
    };
  } catch (err) {
    return {
      step,
      status: 'failed',
      duration: Date.now() - stepStart,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function performStep(page: Page, step: ExecutionStep): Promise<void> {
  switch (step.action) {
    case 'click':
      await page.click(step.selector!, { timeout: step.timeout ?? 10000 });
      break;

    case 'type':
      await page.fill(step.selector!, step.value ?? '', { timeout: step.timeout ?? 10000 });
      break;

    case 'navigate':
      await page.goto(step.value!, { waitUntil: 'networkidle', timeout: step.timeout ?? 30000 });
      break;

    case 'wait':
      if (step.selector) {
        await page.waitForSelector(step.selector, {
          state: 'visible',
          timeout: step.timeout ?? 10000,
        });
      } else {
        await page.waitForTimeout(parseInt(step.value ?? '1000', 10) || 1000);
      }
      break;

    case 'scroll':
      if (step.selector) {
        await page.evaluate(
          (sel: string) => document.querySelector(sel)?.scrollIntoView(),
          step.selector
        );
      } else {
        await page.evaluate(() => window.scrollBy(0, 300));
      }
      break;

    case 'hover':
      await page.hover(step.selector!, { timeout: step.timeout ?? 10000 });
      break;

    case 'select':
      await page.selectOption(step.selector!, step.value ?? '', {
        timeout: step.timeout ?? 10000,
      });
      break;

    case 'clear':
      await page.fill(step.selector!, '', { timeout: step.timeout ?? 10000 });
      break;

    case 'press_key':
      await page.press(step.selector ?? 'body', step.key ?? 'Enter');
      break;

    case 'assert':
      await executeAssertion(page, step);
      break;

    default: {
      const exhaustive: never = step.action;
      throw new Error(`Unknown action type: ${exhaustive}`);
    }
  }
}

async function executeAssertion(page: Page, step: ExecutionStep): Promise<void> {
  const sel = step.selector ?? 'body';
  const expected = step.assertExpected ?? '';
  const timeout = step.timeout ?? 10000;

  switch (step.assertType) {
    case 'visible':
      await page.locator(sel).waitFor({ state: 'visible', timeout });
      break;

    case 'not_visible':
      await page.locator(sel).waitFor({ state: 'hidden', timeout });
      break;

    case 'text': {
      const txt = await page.locator(sel).innerText({ timeout });
      if (!txt.includes(expected)) {
        throw new Error(
          `Expected element "${sel}" to contain text "${expected}", but got "${txt}"`
        );
      }
      break;
    }

    case 'not_text': {
      const txt = await page.locator(sel).innerText({ timeout });
      if (txt.includes(expected)) {
        throw new Error(
          `Expected element "${sel}" NOT to contain text "${expected}", but it did`
        );
      }
      break;
    }

    case 'url': {
      const url = page.url();
      if (!url.includes(expected)) {
        throw new Error(`Expected URL to contain "${expected}", but got "${url}"`);
      }
      break;
    }

    case 'count': {
      const count = await page.locator(sel).count();
      const minCount = parseInt(expected, 10);
      if (count < minCount) {
        throw new Error(
          `Expected at least ${minCount} element(s) matching "${sel}", but found ${count}`
        );
      }
      break;
    }

    case 'exact_count': {
      const count = await page.locator(sel).count();
      const exactCount = parseInt(expected, 10);
      if (count !== exactCount) {
        throw new Error(
          `Expected exactly ${exactCount} element(s) matching "${sel}", but found ${count}`
        );
      }
      break;
    }

    case 'enabled':
      await expect(page.locator(sel)).toBeEnabled({ timeout });
      break;

    case 'disabled':
      await expect(page.locator(sel)).toBeDisabled({ timeout });
      break;

    case 'value': {
      const v = await page.locator(sel).inputValue({ timeout });
      if (v !== expected) {
        throw new Error(
          `Expected input value of "${sel}" to be "${expected}", but got "${v}"`
        );
      }
      break;
    }

    case 'attribute': {
      const v = await page.locator(sel).getAttribute(step.attribute!, { timeout });
      if (v !== expected) {
        throw new Error(
          `Expected attribute "${step.attribute}" of "${sel}" to be "${expected}", but got "${v ?? 'null'}"`
        );
      }
      break;
    }

    case 'exists': {
      const count = await page.locator(sel).count();
      if (count === 0) {
        throw new Error(`Expected element "${sel}" to exist in the DOM, but it was not found`);
      }
      break;
    }

    case 'not_exists': {
      const count = await page.locator(sel).count();
      if (count > 0) {
        throw new Error(
          `Expected element "${sel}" to be absent from the DOM, but found ${count} instance(s)`
        );
      }
      break;
    }

    default:
      throw new Error(`Unknown assertType: ${step.assertType}`);
  }
}
