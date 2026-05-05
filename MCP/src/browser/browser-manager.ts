import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createLogger } from '../utils/logger.js';

const log = createLogger('browser');

let browser: Browser | null = null;
let context: BrowserContext | null = null;

export async function launchBrowser(headless = true, storageStatePath?: string): Promise<BrowserContext> {
  if (context) return context;
  browser = await chromium.launch({ headless });
  const ctxOptions: Parameters<typeof browser.newContext>[0] = {
    viewport: { width: 1280, height: 720 },
    userAgent: 'pathfinder/1.0 (AI QA Testing Agent)',
  };
  if (storageStatePath) {
    ctxOptions.storageState = storageStatePath;
    log.info(`Restoring auth state from ${storageStatePath}`);
  }
  context = await browser.newContext(ctxOptions);
  log.info(`Browser launched (headless=${headless})`);
  return context;
}

/**
 * Inject the transient-message capture observer into a page.
 * Runs at the start of every document context so toasts, alerts, snackbars,
 * and field-validation errors are captured the instant they appear in the DOM
 * — even if they disappear before the next assert step runs.
 *
 * Captured messages are stored in window.__pathfinder_captures[].
 */
async function injectCaptureObserver(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as any).__pathfinder_captures = (window as any).__pathfinder_captures ?? [];

    const TRANSIENT_ROLES = new Set(['alert', 'status', 'log', 'marquee']);

    function captureEl(el: Element) {
      const role = el.getAttribute('role') ?? '';
      const ariaLive = el.getAttribute('aria-live') ?? '';
      const cls = typeof el.className === 'string' ? el.className : '';

      const isTransient =
        TRANSIENT_ROLES.has(role) ||
        ariaLive === 'polite' ||
        ariaLive === 'assertive' ||
        /toast|snack|notif|MuiAlert|Toastify|ant-message|success-msg|error-msg/i.test(cls);

      if (isTransient) {
        const text = (el.textContent ?? '').trim();
        if (text.length > 0 && text.length < 500) {
          (window as any).__pathfinder_captures.push({ text, role, cls: cls.split(' ')[0], ts: Date.now() });
        }
      }
    }

    function setupObserver() {
      if ((window as any).__pathfinder_observer_active) return;
      (window as any).__pathfinder_observer_active = true;

      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of Array.from(mutation.addedNodes)) {
            if ((node as Node).nodeType !== 1) continue;
            const el = node as Element;
            captureEl(el);
            el.querySelectorAll('[role="alert"],[role="status"],[aria-live]').forEach(captureEl);
          }
        }
      });

      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
      } else {
        document.addEventListener('DOMContentLoaded', () => {
          observer.observe(document.body, { childList: true, subtree: true });
        });
      }
    }

    setupObserver();
  }).catch(() => {});
}

export async function newPage(): Promise<Page> {
  if (!context) throw new Error('Browser not launched');
  const page = await context.newPage();
  await page.addInitScript({ path: new URL('./dom-actions-inject.js', import.meta.url).pathname }).catch(() => {});
  await injectCaptureObserver(page);
  return page;
}

/** Exported so isolated-context pages can also get the capture observer. */
export { injectCaptureObserver };

/**
 * Create a fresh, isolated BrowserContext for a single test run.
 * Reuses the global browser process but provides a clean cookie/localStorage
 * environment so concurrent tests cannot contaminate each other.
 *
 * Callers are responsible for calling context.close() when the test finishes.
 */
export async function newIsolatedContext(
  headless = true,
  storageStatePath?: string
): Promise<BrowserContext> {
  if (!browser) {
    browser = await chromium.launch({ headless });
    log.info(`Browser launched for isolated context (headless=${headless})`);
  }
  const ctxOptions: Parameters<typeof browser.newContext>[0] = {
    viewport: { width: 1280, height: 720 },
    userAgent: 'pathfinder/1.0 (AI QA Testing Agent)',
  };
  if (storageStatePath) {
    ctxOptions.storageState = storageStatePath;
    log.info(`Restoring auth state from ${storageStatePath}`);
  }
  const isolatedCtx = await browser.newContext(ctxOptions);
  log.info('Isolated browser context created');
  return isolatedCtx;
}

export async function closeBrowser(): Promise<void> {
  if (context) { await context.close().catch(() => {}); context = null; }
  if (browser) { await browser.close().catch(() => {}); browser = null; }
  log.info('Browser closed');
}

export async function getContext(): Promise<BrowserContext> {
  if (!context) throw new Error('Browser not launched');
  return context;
}
