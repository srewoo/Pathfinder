/**
 * E2E tests: pathfinder Chrome Extension — Sidebar Flows
 *
 * These tests require the Playwright extension testing harness and a built
 * copy of the extension loaded into a Chromium instance with extension support.
 *
 * HOW TO RUN:
 *   1. Build the extension:  npm run build:chrome
 *   2. Install Playwright:   npx playwright install chromium
 *   3. Run e2e tests:        npx playwright test test/e2e/
 *
 * The tests launch a Chromium browser with the extension loaded from dist/,
 * open the Chrome Side Panel, and verify UI flows.
 *
 * NOTE: These tests are intentionally marked as TODO stubs within Vitest
 * and are designed to run via Playwright directly (not via vitest).
 * They are tracked here for completeness against the project plan.
 */

import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import { resolve } from 'path';

const EXTENSION_PATH = resolve(process.cwd(), 'dist');
const SIDEPANEL_URL = `chrome-extension://*/src/sidepanel/index.html`;

let context: BrowserContext;

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-sandbox',
    ],
  });
});

test.afterAll(async () => {
  await context.close();
});

test.describe('Sidebar: initial state', () => {
  test('given extension loaded when sidepanel opened then displays pathfinder header', async () => {
    const pages = context.pages();
    const sidepanelPage = pages.find((p) => p.url().includes('sidepanel')) ?? await context.newPage();

    // Navigate to the side panel URL directly for testing
    await sidepanelPage.goto(EXTENSION_PATH + '/src/sidepanel/index.html');
    await sidepanelPage.waitForLoadState('domcontentloaded');

    const heading = sidepanelPage.locator('h1', { hasText: 'pathfinder' });
    await expect(heading).toBeVisible({ timeout: 5000 });
  });

  test('given no API key configured when sidepanel opened then settings modal is shown', async () => {
    const page = await context.newPage();
    await page.goto(EXTENSION_PATH + '/src/sidepanel/index.html');
    await page.waitForLoadState('domcontentloaded');

    // Settings modal should open automatically when no API key is set
    const modal = page.locator('[role="dialog"]');
    await expect(modal).toBeVisible({ timeout: 5000 });
    await page.close();
  });
});

test.describe('Sidebar: tab navigation', () => {
  let page: Awaited<ReturnType<BrowserContext['newPage']>>;

  test.beforeEach(async () => {
    page = await context.newPage();
    await page.goto(EXTENSION_PATH + '/src/sidepanel/index.html');
    await page.waitForLoadState('domcontentloaded');

    // Dismiss settings modal if present
    const closeBtn = page.locator('button[aria-label="Close"], button:has-text("×")');
    if (await closeBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await closeBtn.click();
    }
  });

  test.afterEach(async () => {
    await page.close();
  });

  test('given sidepanel when clicking Explore tab then explore panel becomes visible', async () => {
    await page.locator('button', { hasText: 'Explore' }).click();
    await expect(page.locator('text=Autonomous Exploration')).toBeVisible({ timeout: 3000 });
  });

  test('given sidepanel when clicking Tests tab then test panel becomes visible', async () => {
    await page.locator('button', { hasText: 'Tests' }).click();
    await expect(page.locator('text=Test Cases')).toBeVisible({ timeout: 3000 });
  });

  test('given sidepanel when clicking Results tab then results panel becomes visible', async () => {
    await page.locator('button', { hasText: 'Results' }).click();
    await expect(page.locator('text=Test Results')).toBeVisible({ timeout: 3000 });
  });

  test('given sidepanel when clicking Flows tab then flows panel becomes visible', async () => {
    await page.locator('button', { hasText: 'Flows' }).click();
    await expect(page.locator('text=Learned Flows')).toBeVisible({ timeout: 3000 });
  });

  test('given sidepanel when clicking Knowledge tab then knowledge panel becomes visible', async () => {
    await page.locator('button', { hasText: 'Knowledge' }).click();
    await expect(page.locator('text=Knowledge Base')).toBeVisible({ timeout: 3000 });
  });
});

test.describe('Sidebar: Settings panel', () => {
  test('given settings opened when selecting provider then model input updates', async () => {
    const page = await context.newPage();
    await page.goto(EXTENSION_PATH + '/src/sidepanel/index.html');
    await page.waitForLoadState('domcontentloaded');

    const settingsBtn = page.locator('button[title="Settings"]');
    await settingsBtn.click();

    const providerSelect = page.locator('select');
    await expect(providerSelect).toBeVisible({ timeout: 3000 });

    await providerSelect.selectOption('anthropic');
    const modelInput = page.locator('input[placeholder*="claude"]');
    await expect(modelInput).toBeVisible({ timeout: 2000 });

    await page.close();
  });

  test('given API key entered when saved then header shows provider status as green', async () => {
    const page = await context.newPage();
    await page.goto(EXTENSION_PATH + '/src/sidepanel/index.html');
    await page.waitForLoadState('domcontentloaded');

    const settingsBtn = page.locator('button[title="Settings"]');
    await settingsBtn.click();

    const apiKeyInput = page.locator('input[type="password"], input[placeholder*="sk-"]');
    await apiKeyInput.fill('sk-test-integration-key');

    const saveBtn = page.locator('button', { hasText: 'Save' });
    await saveBtn.click();

    // Header should now show green status dot
    const statusDot = page.locator('.bg-success');
    await expect(statusDot).toBeVisible({ timeout: 3000 });

    await page.close();
  });
});

test.describe('Sidebar: First-run guided tour', () => {
  async function openFresh(): Promise<Awaited<ReturnType<BrowserContext['newPage']>>> {
    const page = await context.newPage();
    await page.goto(EXTENSION_PATH + '/src/sidepanel/index.html');
    await page.waitForLoadState('domcontentloaded');
    // Reset the one-time tour flag so it shows again, then reload.
    await page.evaluate(() => localStorage.removeItem('pathfinder.onboarding.v1'));
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    // Dismiss the settings modal if it auto-opened (no API key) so the tour shows.
    const closeBtn = page.locator('button[aria-label="Close"]');
    if (await closeBtn.isVisible({ timeout: 800 }).catch(() => false)) await closeBtn.click();
    return page;
  }

  test('given a first-run user when the panel loads then the welcome tour is shown', async () => {
    const page = await openFresh();
    await expect(page.locator('text=Welcome to Pathfinder')).toBeVisible({ timeout: 4000 });
    await expect(page.locator('text=Step 1 of 6')).toBeVisible();
    await page.close();
  });

  test('given the tour when Next is clicked then it advances to step 2 (Knowledge)', async () => {
    const page = await openFresh();
    await page.locator('button', { hasText: 'Next' }).click();
    await expect(page.locator('text=Step 2 of 6')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('text=index your docs')).toBeVisible();
    await page.close();
  });

  test('given the tour when Skip is clicked then it is dismissed', async () => {
    const page = await openFresh();
    await page.locator('button', { hasText: 'Skip tour' }).click();
    await expect(page.locator('text=Welcome to Pathfinder')).toBeHidden({ timeout: 3000 });
    await page.close();
  });

  test('given the tour was dismissed when Help is clicked then it replays', async () => {
    const page = await openFresh();
    await page.locator('button', { hasText: 'Skip tour' }).click();
    await page.locator('button[aria-label="Replay getting-started tour"]').click();
    await expect(page.locator('text=Welcome to Pathfinder')).toBeVisible({ timeout: 3000 });
    await page.close();
  });
});

test.describe('Sidebar: Explorer controls', () => {
  test.beforeEach(async ({}, testInfo) => {
    testInfo.setTimeout(20000);
  });

  async function openExplore(): Promise<Awaited<ReturnType<BrowserContext['newPage']>>> {
    const page = await context.newPage();
    await page.goto(EXTENSION_PATH + '/src/sidepanel/index.html');
    await page.waitForLoadState('domcontentloaded');
    const closeBtn = page.locator('button[aria-label="Close"]');
    if (await closeBtn.isVisible({ timeout: 500 }).catch(() => false)) await closeBtn.click();
    await page.locator('button', { hasText: 'Explore' }).click();
    return page;
  }

  test('given Explore tab when opened then a Single-page toggle is present and off by default', async () => {
    const page = await openExplore();
    const toggle = page.locator('#single-page-toggle');
    await expect(toggle).toBeVisible({ timeout: 3000 });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await page.close();
  });

  test('given Explore tab when opened then Submit-forms is OFF by default (read-only)', async () => {
    const page = await openExplore();
    const toggle = page.locator('#submit-forms-toggle');
    await expect(toggle).toBeVisible({ timeout: 3000 });
    // Read-only by default — exploration must not mutate the app unless opted in.
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await page.close();
  });

  test('given Submit-forms toggle when clicked then it switches on', async () => {
    const page = await openExplore();
    const toggle = page.locator('#submit-forms-toggle');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await page.close();
  });

  test('given Single-page enabled when toggled then the Depth selector is hidden', async () => {
    const page = await openExplore();
    await expect(page.locator('text=Exploration Depth')).toBeVisible({ timeout: 3000 });
    await page.locator('#single-page-toggle').click();
    await expect(page.locator('text=Exploration Depth')).toBeHidden({ timeout: 3000 });
    await page.close();
  });
});

test.describe('Sidebar: Knowledge panel', () => {
  test('given Knowledge tab active when URL entered then crawl button is present', async () => {
    const page = await context.newPage();
    await page.goto(EXTENSION_PATH + '/src/sidepanel/index.html');
    await page.waitForLoadState('domcontentloaded');

    // Dismiss settings if shown
    const closeBtn = page.locator('button[aria-label="Close"]');
    if (await closeBtn.isVisible({ timeout: 500 }).catch(() => false)) {
      await closeBtn.click();
    }

    const urlInput = page.locator('input[placeholder*="https://"], input[type="url"]');
    await urlInput.fill('https://docs.example.com');

    const crawlBtn = page.locator('button', { hasText: 'Crawl' });
    await expect(crawlBtn).toBeEnabled({ timeout: 2000 });

    await page.close();
  });
});
