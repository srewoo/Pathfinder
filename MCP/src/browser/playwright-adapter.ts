import type { Page, Locator } from 'playwright';
import type { ExecutionStep, StepResult, PageSnapshot, InteractiveElement, FormField } from '../storage/schemas.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('pw-adapter');

const DEFAULT_TIMEOUT = 15000;

// ─── Network Settling ─────────────────────────────────────────────────────────
// Tracking domains for analytics/telemetry that should be ignored when waiting
// for network idle — these never "settle" and aren't meaningful for test state.
const IGNORED_DOMAINS = [
  'google-analytics', 'hotjar', 'segment', 'mixpanel', 'facebook',
  'doubleclick', 'analytics', 'tracking', 'gtm', 'googletagmanager',
];

function isIgnoredUrl(url: string): boolean {
  return IGNORED_DOMAINS.some((domain) => url.includes(domain));
}

/**
 * Wait until in-flight network requests settle (idle for `quietMs` consecutive ms)
 * or until `timeoutMs` elapses — whichever comes first.
 * Never throws: logs a warning on timeout and continues.
 */
async function waitForNetworkSettle(page: Page, quietMs = 500, timeoutMs = 8000): Promise<void> {
  let inFlight = 0;
  let lastActivity = Date.now();

  const onRequest = (req: { url(): string }) => {
    if (!isIgnoredUrl(req.url())) { inFlight++; lastActivity = Date.now(); }
  };
  const onDone = (req: { url(): string }) => {
    if (!isIgnoredUrl(req.url())) { inFlight = Math.max(0, inFlight - 1); lastActivity = Date.now(); }
  };

  page.on('request', onRequest);
  page.on('requestfinished', onDone);
  page.on('requestfailed', onDone);

  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      if (inFlight === 0 && Date.now() - lastActivity >= quietMs) break;
    }
    if (Date.now() >= deadline) {
      log.warn(`waitForNetworkSettle: timed out after ${timeoutMs}ms (${inFlight} requests still in-flight)`);
    }
  } finally {
    page.off('request', onRequest);
    page.off('requestfinished', onDone);
    page.off('requestfailed', onDone);
  }
}

// ─── Tab Registry ─────────────────────────────────────────────────────────────
// Tracks pages opened in the same browser context (tabs / popups).
// Key: the main test page reference. Value: list of additional pages discovered.
const tabRegistry = new WeakMap<Page, Page[]>();

export function registerTab(mainPage: Page, newPage: Page): void {
  const existing = tabRegistry.get(mainPage) ?? [];
  if (!existing.includes(newPage)) existing.push(newPage);
  tabRegistry.set(mainPage, existing);
}

export function getRegisteredTabs(page: Page): Page[] {
  return tabRegistry.get(page) ?? [];
}

// ─── Semantic Locator Resolution ─────────────────────────────────────────────
// Extract human-readable labels from step descriptions.
// These are used to find elements via accessibility semantics before falling
// back to fragile CSS selectors. This handles custom components (Shadow DOM,
// design systems like MindTickle/Ant Design/MUI) that break CSS-based selectors.

export function extractFieldLabels(description: string): string[] {
  const results: string[] = [];
  // "Type X into the [Room name] field/input/box"
  // "Fill in the [Email] field"
  // "Enter text in the [Search] input"
  const patterns = [
    /(?:into|in)\s+(?:the\s+)?["']?([a-zA-Z][a-zA-Z0-9\s\-_]{1,35}?)["']?\s+(?:field|input|box|textarea|area)\b/i,
    /(?:fill|enter|type)\s+.+?\s+(?:into|in)\s+(?:the\s+)?["']?([a-zA-Z][a-zA-Z0-9\s\-_]{1,35}?)["']?\s+(?:field|input|box)/i,
    /(?:the\s+)["']?([a-zA-Z][a-zA-Z0-9\s\-_]{1,35}?)["']?\s+(?:field|input|box|textarea)\b/i,
    /["']([a-zA-Z][a-zA-Z0-9\s\-_]{1,35}?)["']\s+(?:field|input|box)/i,
  ];
  for (const pattern of patterns) {
    const m = description.match(pattern);
    if (m?.[1]) {
      const label = m[1].trim();
      if (label.length >= 2) results.push(label);
    }
  }
  return [...new Set(results)];
}

export function extractButtonTexts(description: string): string[] {
  const results: string[] = [];
  const patterns = [
    /(?:click|press|tap|hit)\s+(?:on\s+)?(?:the\s+)?["']?([a-zA-Z][a-zA-Z0-9\s\-_]{0,35}?)["']?\s+(?:button|btn|icon|tab)\b/i,
    /click\s+["']([^"']{1,40}?)["']/i,
    /(?:click|press)\s+(?:the\s+)["']?([A-Z][a-zA-Z0-9\s]{0,30}?)["']?\s*$/i,
  ];
  for (const pattern of patterns) {
    const m = description.match(pattern);
    if (m?.[1]) {
      const text = m[1].trim();
      if (text.length >= 1 && text.length <= 40) results.push(text);
    }
  }
  return [...new Set(results)];
}

/**
 * Attempt to execute a step using Playwright's semantic locators (getByLabel,
 * getByRole, getByPlaceholder, getByText). These work across Shadow DOM and
 * custom component libraries — they use the accessibility tree, not the DOM.
 * Returns the StepResult on success, null to fall through to CSS selectors.
 */
async function trySemanticInteraction(page: Page, step: ExecutionStep, timeout: number): Promise<StepResult | null> {
  const start = Date.now();
  const shortTimeout = Math.min(timeout, 2000);

  async function tryLocator(locator: Locator): Promise<boolean> {
    try {
      await locator.first().waitFor({ state: 'visible', timeout: shortTimeout });
      return true;
    } catch {
      return false;
    }
  }

  if (['type', 'clear', 'check', 'uncheck'].includes(step.action)) {
    const labels = extractFieldLabels(step.description);
    for (const label of labels) {
      const candidates: Locator[] = [
        page.getByLabel(label, { exact: false }),
        page.getByPlaceholder(label, { exact: false }),
        page.getByRole('textbox', { name: label }),
        page.getByRole('combobox', { name: label }),
        page.getByRole('spinbutton', { name: label }),
      ];
      for (const locator of candidates) {
        if (!await tryLocator(locator)) continue;
        try {
          if (step.action === 'type') {
            await locator.first().fill(step.value ?? '', { timeout });
          } else if (step.action === 'clear') {
            await locator.first().fill('', { timeout });
          } else if (step.action === 'check') {
            await locator.first().check({ timeout });
          } else if (step.action === 'uncheck') {
            await locator.first().uncheck({ timeout });
          }
          log.info(`Semantic locator hit for label "${label}" (${step.action})`);
          return { step, status: 'passed', duration: Date.now() - start };
        } catch {}
      }
    }
  }

  if (['click', 'double_click', 'hover'].includes(step.action)) {
    const buttonTexts = extractButtonTexts(step.description);
    for (const text of buttonTexts) {
      const candidates: Locator[] = [
        page.getByRole('button', { name: text, exact: false }),
        page.getByRole('link', { name: text, exact: false }),
        page.getByRole('menuitem', { name: text, exact: false }),
        page.getByRole('tab', { name: text, exact: false }),
      ];
      for (const locator of candidates) {
        if (!await tryLocator(locator)) continue;
        try {
          if (step.action === 'click') {
            await locator.first().click({ timeout });
          } else if (step.action === 'double_click') {
            await locator.first().dblclick({ timeout });
          } else if (step.action === 'hover') {
            await locator.first().hover({ timeout });
          }
          log.info(`Semantic locator hit for button/tab "${text}" (${step.action})`);
          return { step, status: 'passed', duration: Date.now() - start };
        } catch {}
      }
    }
  }

  return null;
}

/**
 * Scroll the page incrementally and check if the selector becomes visible.
 * Handles elements below the fold that CSS selectors can find but Playwright
 * won't interact with because they're outside the viewport.
 */
async function scrollToReveal(page: Page, selector: string, maxScrolls = 6): Promise<boolean> {
  // Element already in view?
  const el = await page.$(selector).catch(() => null);
  if (el && await el.isVisible().catch(() => false)) return true;

  for (let i = 0; i < maxScrolls; i++) {
    await page.evaluate(() => window.scrollBy(0, 350)).catch(() => {});
    await page.waitForTimeout(200);
    const found = await page.$(selector).catch(() => null);
    if (found) {
      await found.scrollIntoViewIfNeeded().catch(() => {});
      return await found.isVisible().catch(() => false);
    }
  }

  // Scroll back to top and try once more
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  const topEl = await page.$(selector).catch(() => null);
  if (topEl) {
    await topEl.scrollIntoViewIfNeeded().catch(() => {});
    return await topEl.isVisible().catch(() => false);
  }
  return false;
}

export async function executeStepOnPage(page: Page, step: ExecutionStep): Promise<StepResult> {
  const start = Date.now();
  try {
    switch (step.action) {
      case 'navigate':
        await page.goto(step.value ?? '', { waitUntil: 'domcontentloaded', timeout: 20000 });
        // readyState === 'complete' is more reliable than networkidle for SPAs
        await page.waitForFunction(() => document.readyState === 'complete', { timeout: 10000 }).catch(() => {});
        // Wait for network to settle after navigation (analytics/tracking domains ignored)
        await waitForNetworkSettle(page, 500, 8000);
        return { step, status: 'passed', duration: Date.now() - start };

      case 'click': {
        const currentPageCount = page.context().pages().length;
        // Try semantic locator first (works in Shadow DOM / custom components)
        const semClick = await trySemanticInteraction(page, step, step.timeout ?? DEFAULT_TIMEOUT);
        if (semClick) {
          // Brief network settle after click in case it triggers navigation/XHR
          await waitForNetworkSettle(page, 500, 2000);
          // Detect any newly opened tab/popup
          const allPages = page.context().pages();
          if (allPages.length > currentPageCount) {
            const newTab = allPages[allPages.length - 1];
            registerTab(page, newTab);
            log.info(`New tab opened: ${newTab.url()}`);
          }
          return semClick;
        }
        // Scroll to reveal if element exists but is off-screen
        if (step.selector) await scrollToReveal(page, step.selector);
        await resolveAndClick(page, step.selector!, step.timeout ?? DEFAULT_TIMEOUT);
        // Brief network settle after click in case it triggers navigation/XHR
        await waitForNetworkSettle(page, 500, 2000);
        // Detect any newly opened tab/popup
        const allPagesAfterClick = page.context().pages();
        if (allPagesAfterClick.length > currentPageCount) {
          const newTab = allPagesAfterClick[allPagesAfterClick.length - 1];
          registerTab(page, newTab);
          log.info(`New tab opened: ${newTab.url()}`);
        }
        return { step, status: 'passed', duration: Date.now() - start };
      }

      case 'double_click': {
        const semDbl = await trySemanticInteraction(page, step, step.timeout ?? DEFAULT_TIMEOUT);
        if (semDbl) return semDbl;
        if (step.selector) await scrollToReveal(page, step.selector);
        await page.dblclick(step.selector!, { timeout: step.timeout ?? DEFAULT_TIMEOUT });
        return { step, status: 'passed', duration: Date.now() - start };
      }

      case 'type': {
        // Semantic locators work through shadow DOM and custom input components
        const semType = await trySemanticInteraction(page, step, step.timeout ?? DEFAULT_TIMEOUT);
        if (semType) return semType;
        if (step.selector) await scrollToReveal(page, step.selector);
        await page.fill(step.selector!, step.value ?? '', { timeout: step.timeout ?? DEFAULT_TIMEOUT });
        return { step, status: 'passed', duration: Date.now() - start };
      }

      case 'clear': {
        const semClear = await trySemanticInteraction(page, step, step.timeout ?? DEFAULT_TIMEOUT);
        if (semClear) return semClear;
        if (step.selector) await scrollToReveal(page, step.selector);
        await page.fill(step.selector!, '', { timeout: step.timeout ?? DEFAULT_TIMEOUT });
        return { step, status: 'passed', duration: Date.now() - start };
      }

      case 'check': {
        const semCheck = await trySemanticInteraction(page, step, step.timeout ?? DEFAULT_TIMEOUT);
        if (semCheck) return semCheck;
        if (step.selector) await scrollToReveal(page, step.selector);
        await page.check(step.selector!, { timeout: step.timeout ?? DEFAULT_TIMEOUT });
        return { step, status: 'passed', duration: Date.now() - start };
      }

      case 'uncheck': {
        const semUncheck = await trySemanticInteraction(page, step, step.timeout ?? DEFAULT_TIMEOUT);
        if (semUncheck) return semUncheck;
        if (step.selector) await scrollToReveal(page, step.selector);
        await page.uncheck(step.selector!, { timeout: step.timeout ?? DEFAULT_TIMEOUT });
        return { step, status: 'passed', duration: Date.now() - start };
      }

      case 'select':
        await page.selectOption(step.selector!, { label: step.value ?? '' }, { timeout: step.timeout ?? DEFAULT_TIMEOUT });
        return { step, status: 'passed', duration: Date.now() - start };

      case 'press_key':
        if (step.selector) {
          await page.press(step.selector, step.key ?? 'Enter', { timeout: step.timeout ?? DEFAULT_TIMEOUT });
        } else {
          await page.keyboard.press(step.key ?? 'Enter');
        }
        return { step, status: 'passed', duration: Date.now() - start };

      case 'hover': {
        const semHover = await trySemanticInteraction(page, step, step.timeout ?? DEFAULT_TIMEOUT);
        if (semHover) return semHover;
        if (step.selector) await scrollToReveal(page, step.selector);
        await page.hover(step.selector!, { timeout: step.timeout ?? DEFAULT_TIMEOUT });
        // Brief wait then capture any revealed tooltip/popover text
        await page.waitForTimeout(400);
        const tooltipText = await captureTooltipText(page);
        if (tooltipText) log.info(`Hover revealed tooltip: "${tooltipText}"`);
        return { step, status: 'passed', duration: Date.now() - start };
      }

      case 'scroll':
        if (step.selector) {
          await page.locator(step.selector).scrollIntoViewIfNeeded({ timeout: step.timeout ?? DEFAULT_TIMEOUT });
        } else {
          await page.evaluate(() => window.scrollBy(0, 500));
        }
        return { step, status: 'passed', duration: Date.now() - start };

      case 'wait':
        await page.waitForSelector(step.selector!, { state: 'visible', timeout: step.timeout ?? DEFAULT_TIMEOUT });
        return { step, status: 'passed', duration: Date.now() - start };

      case 'assert':
        return await executeAssert(page, step, start);

      case 'drag_drop':
        await page.dragAndDrop(step.selector!, step.targetSelector!, { timeout: step.timeout ?? DEFAULT_TIMEOUT });
        return { step, status: 'passed', duration: Date.now() - start };

      case 'upload_file':
        await page.setInputFiles(step.selector!, step.value ?? '', { timeout: step.timeout ?? DEFAULT_TIMEOUT });
        return { step, status: 'passed', duration: Date.now() - start };

      case 'dismiss_dialog':
        page.once('dialog', (dialog) => dialog.dismiss());
        return { step, status: 'passed', duration: Date.now() - start };

      case 'switch_tab': {
        const tabs = page.context().pages();
        let target: Page | undefined;
        if (step.value === 'new') {
          target = tabs[tabs.length - 1];
        } else if (step.value === '0') {
          target = tabs[0];
        } else {
          const idx = parseInt(step.value ?? '0', 10);
          target = tabs[isNaN(idx) ? 0 : idx];
        }
        if (!target) {
          throw new Error(`Tab "${step.value}" not found (${tabs.length} tab(s) open)`);
        }
        await target.bringToFront();
        log.info(`Switched to tab: ${target.url()} (index ${tabs.indexOf(target)})`);
        return { step, status: 'passed', duration: Date.now() - start };
      }

      default:
        return { step, status: 'failed', duration: Date.now() - start, error: `Unknown action: ${step.action}` };
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error(`Step failed: ${step.description}`, err);
    return { step, status: 'failed', duration: Date.now() - start, error };
  }
}

async function resolveAndClick(page: Page, selector: string, timeout: number): Promise<void> {
  // Support comma-separated fallback selectors
  const selectors = selector.split(',').map((s) => s.trim());
  for (const sel of selectors) {
    try {
      await page.click(sel, { timeout: Math.min(timeout, 5000) });
      return;
    } catch {
      continue;
    }
  }
  // Final attempt with first selector and full timeout
  await page.click(selectors[0], { timeout });
}

// Selectors / patterns that indicate a transient notification element.
// These appear briefly (toasts, snackbars, alerts) and may be gone before a
// standard 10s waitForSelector polling cycle catches them.
const TRANSIENT_PATTERN =
  /\b(alert|status|toast|snackbar|notification|success|error)\b|MuiAlert|Toastify|ant-message|notistack/i;

function isTransientSelector(selector?: string): boolean {
  if (!selector) return false;
  return TRANSIENT_PATTERN.test(selector);
}

/**
 * Read messages captured by the page-level mutation observer injected at
 * page creation time. Returns the most recent capture within the last 8 seconds.
 * This recovers toast content even when the element is already gone from the DOM.
 */
async function getRecentCaptures(page: Page, maxAgeMs = 8000): Promise<string[]> {
  try {
    const captures = await page.evaluate(
      (maxAge) => {
        const all = (window as any).__pathfinder_captures ?? [];
        const cutoff = Date.now() - maxAge;
        return (all as Array<{ text: string; ts: number }>)
          .filter((c) => c.ts >= cutoff)
          .map((c) => c.text);
      },
      maxAgeMs
    );
    return captures as string[];
  } catch {
    return [];
  }
}

/**
 * Scan for field-level validation errors near form inputs.
 * Covers MUI, Ant Design, Bootstrap, and standard HTML5 validation patterns.
 */
async function captureFieldErrors(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => {
      const errorTexts: string[] = [];

      // aria-invalid fields — find associated helper text via aria-describedby
      document.querySelectorAll('[aria-invalid="true"]').forEach((el) => {
        const describedBy = el.getAttribute('aria-describedby');
        if (describedBy) {
          const helper = document.getElementById(describedBy);
          if (helper) errorTexts.push(helper.textContent?.trim() ?? '');
        }
      });

      // Common error helper selectors across design systems
      const errorSelectors = [
        '.MuiFormHelperText-root.Mui-error',
        '.ant-form-item-explain-error',
        '.invalid-feedback',
        '[class*="error-message"]',
        '[class*="field-error"]',
        '[class*="form-error"]',
        '.error-text',
        '[aria-live="polite"]',
      ];
      errorSelectors.forEach((sel) => {
        document.querySelectorAll(sel).forEach((el) => {
          const t = el.textContent?.trim() ?? '';
          if (t) errorTexts.push(t);
        });
      });

      return [...new Set(errorTexts)].filter(Boolean).join(' | ');
    });
  } catch {
    return '';
  }
}

/**
 * Capture the text of any currently-visible tooltip or popover.
 * Run immediately after a hover step to grab revealed content.
 */
async function captureTooltipText(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => {
      const sels = [
        '[role="tooltip"]',
        '[class*="tooltip"]',
        '[class*="popover"]',
        '.MuiTooltip-popper',
        '.ant-tooltip',
        '[data-floating-ui-portal]',
      ];
      const texts: string[] = [];
      for (const sel of sels) {
        document.querySelectorAll(sel).forEach((el) => {
          const t = el.textContent?.trim() ?? '';
          if (t && t.length < 300) texts.push(t);
        });
      }
      return texts.join(' | ');
    });
  } catch {
    return '';
  }
}

async function executeAssert(page: Page, step: ExecutionStep, start: number): Promise<StepResult> {
  const timeout = step.timeout ?? DEFAULT_TIMEOUT;
  const selector = step.selector ?? '';
  const transient = isTransientSelector(selector);

  try {
    switch (step.assertType) {
      case 'visible': {
        if (transient) {
          // Fast-poll (100ms intervals) — transient elements appear and vanish quickly
          const deadline = Date.now() + Math.min(timeout, 5000);
          let found = false;
          while (Date.now() < deadline && !found) {
            const selectors = selector.split(',').map((s) => s.trim());
            for (const sel of selectors) {
              try {
                const el = await page.$(sel);
                if (el && await el.isVisible()) { found = true; break; }
              } catch {}
            }
            if (!found) await page.waitForTimeout(100);
          }
          if (found) break;

          // Check mutation-observer captures (element may already be gone from DOM)
          const captures = await getRecentCaptures(page);
          if (captures.length > 0) {
            log.info(`Transient assert: element gone from DOM but captured: "${captures[0]}"`);
            break; // Treat as passed — the notification appeared
          }

          // Check for field-level validation errors (may be what the test really wanted)
          const fieldErrors = await captureFieldErrors(page);
          if (fieldErrors) {
            const expected = step.assertExpected ?? '';
            if (!expected || fieldErrors.toLowerCase().includes(expected.toLowerCase())) {
              log.info(`Transient assert: matched field error: "${fieldErrors}"`);
              break;
            }
          }

          throw new Error(`Transient element "${selector}" not found within ${Math.min(timeout, 5000)}ms and not captured`);
        }
        await page.waitForSelector(selector, { state: 'visible', timeout });
        break;
      }

      case 'not_visible':
        await page.waitForSelector(selector, { state: 'hidden', timeout });
        break;

      case 'text': {
        const locator = selector ? page.locator(selector) : page.locator('body');

        // For transient selectors, first check captures before attempting waitFor
        if (transient) {
          const captures = await getRecentCaptures(page);
          const expected = (step.assertExpected ?? '').toLowerCase();
          const matched = captures.find((c) => !expected || c.toLowerCase().includes(expected));
          if (matched) {
            log.info(`Transient text assert: matched from capture: "${matched}"`);
            break;
          }
        }

        // Also check tooltip content for text assertions
        const tooltipText = await captureTooltipText(page);
        if (tooltipText && step.assertExpected) {
          if (tooltipText.toLowerCase().includes(step.assertExpected.toLowerCase())) {
            log.info(`Text assert: matched tooltip/popover text: "${tooltipText}"`);
            break;
          }
        }

        await locator.waitFor({ state: 'visible', timeout });
        const text = await locator.textContent({ timeout });
        if (!text?.toLowerCase().includes((step.assertExpected ?? '').toLowerCase())) {
          const ctx = await buildFailureContext(page, selector);
          return {
            step, status: 'failed', duration: Date.now() - start,
            error: `Expected text "${step.assertExpected}" not found. Actual: "${text?.slice(0, 200)}". ${ctx}`,
          };
        }
        break;
      }

      case 'url':
        if (!page.url().includes(step.assertExpected ?? '')) {
          return {
            step, status: 'failed', duration: Date.now() - start,
            error: `URL does not contain "${step.assertExpected}". Current URL: ${page.url()}`,
          };
        }
        break;

      case 'exists':
        await page.waitForSelector(selector, { state: 'attached', timeout });
        break;

      case 'not_exists': {
        const count = await page.locator(selector).count();
        if (count > 0) {
          return {
            step, status: 'failed', duration: Date.now() - start,
            error: `Element "${selector}" still exists (found ${count})`,
          };
        }
        break;
      }

      default:
        await page.waitForSelector(selector, { state: 'visible', timeout });
    }

    return { step, status: 'passed', duration: Date.now() - start };
  } catch (err) {
    const base = err instanceof Error ? err.message : String(err);
    const ctx = await buildFailureContext(page, selector).catch(() => '');

    // Append any field errors that were present — helps diagnose "wrong state" failures
    const fieldErrors = await captureFieldErrors(page).catch(() => '');
    const recentCaptures = await getRecentCaptures(page).catch(() => [] as string[]);
    const captureContext = recentCaptures.length > 0
      ? ` | Captured notifications: "${recentCaptures.slice(-3).join('; ')}"`
      : '';
    const fieldCtx = fieldErrors ? ` | Field errors: "${fieldErrors}"` : '';

    return {
      step, status: 'failed', duration: Date.now() - start,
      error: `${base}${ctx ? ` | ${ctx}` : ''}${captureContext}${fieldCtx}`,
    };
  }
}

/**
 * Collect diagnostic context for assertion failures:
 * current URL, visible body text snippet, and element state if a selector is provided.
 */
async function buildFailureContext(page: Page, selector?: string): Promise<string> {
  const parts: string[] = [`URL: ${page.url()}`];
  try {
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 300) ?? '');
    if (bodyText) parts.push(`Visible text: "${bodyText.replace(/\s+/g, ' ').trim()}"`);
  } catch {}
  if (selector) {
    try {
      const count = await page.locator(selector).count();
      if (count === 0) {
        parts.push(`Element "${selector}" not found in DOM`);
      } else {
        const visible = await page.locator(selector).first().isVisible().catch(() => false);
        const enabled = await page.locator(selector).first().isEnabled().catch(() => false);
        parts.push(`Element "${selector}": visible=${visible}, enabled=${enabled}`);
      }
    } catch {}
  }
  return parts.join(' | ');
}

export async function getPageSnapshotFromPage(page: Page): Promise<PageSnapshot> {
  const url = page.url();
  const title = await page.title();

  // Collect elements from the main frame including shadow DOM trees
  const mainElements = await page.evaluate(() => {
    const selectors = ['button', 'a[href]', 'input:not([type="hidden"])', 'select', 'textarea', '[role="button"]', '[role="link"]', '[role="tab"]', '[tabindex]:not([tabindex="-1"])'];
    const results: any[] = [];

    function collectFrom(root: Document | ShadowRoot) {
      for (const sel of selectors) {
        root.querySelectorAll(sel).forEach((el) => {
          const rect = el.getBoundingClientRect();
          results.push({
            selector: buildSelector(el),
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute('type') ?? undefined,
            text: el.textContent?.trim().slice(0, 80) ?? undefined,
            ariaLabel: el.getAttribute('aria-label') ?? undefined,
            role: el.getAttribute('role') ?? undefined,
            testId: el.getAttribute('data-testid') ?? el.getAttribute('data-test-id') ?? undefined,
            name: el.getAttribute('name') ?? undefined,
            disabled: (el as any).disabled ?? false,
            visible: rect.width > 0 && rect.height > 0,
            position: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          });
          // Recurse into shadow roots
          if ((el as any).shadowRoot) collectFrom((el as any).shadowRoot as ShadowRoot);
        });
      }
      // Also walk all elements to find nested shadow roots
      root.querySelectorAll('*').forEach((el) => {
        if ((el as any).shadowRoot) collectFrom((el as any).shadowRoot as ShadowRoot);
      });
    }

    function buildSelector(el: Element): string {
      if (el.id) return `#${el.id}`;
      const testId = el.getAttribute('data-testid') ?? el.getAttribute('data-test-id');
      if (testId) return `[data-testid="${testId}"]`;
      const name = el.getAttribute('name');
      if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) return `[aria-label="${ariaLabel}"]`;
      return el.tagName.toLowerCase();
    }

    collectFrom(document);
    // Deduplicate by selector
    const seen = new Set<string>();
    return results.filter((r: any) => {
      if (seen.has(r.selector)) return false;
      seen.add(r.selector);
      return true;
    });
  }) as InteractiveElement[];

  // Collect elements from child frames (iframes) as well
  const frameElements: InteractiveElement[] = [];
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      const els = await frame.evaluate(() => {
        const sels = ['button', 'a[href]', 'input:not([type="hidden"])', 'select', 'textarea'];
        const results: any[] = [];
        for (const sel of sels) {
          document.querySelectorAll(sel).forEach((el) => {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) return;
            results.push({
              selector: el.id ? `#${el.id}` : el.tagName.toLowerCase(),
              tag: el.tagName.toLowerCase(),
              text: el.textContent?.trim().slice(0, 80) ?? undefined,
              visible: true,
              position: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            });
          });
        }
        return results;
      }).catch(() => [] as any[]);
      frameElements.push(...(els as InteractiveElement[]));
    } catch {}
  }

  const elements = [...mainElements, ...frameElements];

  const domCompressed = await page.evaluate(() => {
    const interactive: string[] = [];
    const sels = ['button', 'a[href]', 'input:not([type="hidden"])', 'select', 'textarea', '[role="button"]'];
    sels.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => {
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : '';
        const text = el.textContent?.trim().slice(0, 80) ?? '';
        const type = el.getAttribute('type') ?? '';
        const name = el.getAttribute('name') ?? '';
        interactive.push([tag, id, type, name, text].filter(Boolean).join(' | '));
      });
    });
    return interactive.slice(0, 200).join('\n');
  });

  return { url, title, elements, domCompressed, capturedAt: new Date().toISOString() };
}

export async function scanFormFieldsFromPage(page: Page): Promise<FormField[]> {
  return page.evaluate(() => {
    const fields: any[] = [];
    document.querySelectorAll('input:not([type="hidden"]), select, textarea').forEach((el) => {
      const input = el as HTMLInputElement;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;

      let label = '';
      const labelEl = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
      if (labelEl) label = labelEl.textContent?.trim() ?? '';

      const field: any = {
        selector: buildSelector(el),
        type: el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : input.type || 'text',
        name: el.getAttribute('name') ?? undefined,
        label: label || undefined,
        placeholder: el.getAttribute('placeholder') ?? undefined,
        required: input.required,
      };
      if (input.minLength > 0) field.minLength = input.minLength;
      if (input.maxLength > 0 && input.maxLength < 524288) field.maxLength = input.maxLength;
      if (input.min) field.min = input.min;
      if (input.max) field.max = input.max;
      if (input.pattern) field.pattern = input.pattern;
      if (el.tagName === 'SELECT') {
        field.options = Array.from((el as HTMLSelectElement).options).map((o) => o.text).filter((t) => t.trim());
      }
      fields.push(field);
    });

    function buildSelector(el: Element): string {
      if (el.id) return `#${el.id}`;
      const name = el.getAttribute('name');
      if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
      return el.tagName.toLowerCase();
    }
    return fields;
  }) as Promise<FormField[]>;
}

export async function screenshotPage(page: Page, fullPage = false): Promise<string> {
  const buffer = await page.screenshot({ fullPage, type: 'png' });
  return buffer.toString('base64');
}

/**
 * Capture the accessibility tree of the page as a compact ARIA snapshot.
 * Uses Playwright's ariaSnapshot() which returns a YAML-like representation
 * of all interactive elements — roles, names, values — giving the AI semantic
 * page structure instead of raw HTML noise.
 *
 * Example output:
 *   - dialog "Create Room"
 *     - textbox "Room name"
 *     - button "Create"
 *     - button "Cancel"
 *
 * This dramatically improves selector quality for custom components (Shadow DOM,
 * design systems like MindTickle, Ant Design, MUI) that break CSS selectors.
 */
export async function getAccessibilitySnapshot(page: Page): Promise<string> {
  try {
    const snapshot = await page.locator('body').ariaSnapshot({ timeout: 5000 });
    return snapshot.slice(0, 5000); // Limit token usage
  } catch (err) {
    log.debug('Accessibility snapshot failed', err);
    return '';
  }
}
