/**
 * Browser context session pool.
 *
 * Why: launching a Playwright BrowserContext takes 200–500ms and reloads the
 * storage state from disk every time. Tests within a run typically share the
 * same auth profile, so we can reuse contexts and amortize startup cost.
 *
 * Strategy:
 *   • One Browser process per (browserName, headless) tuple.
 *   • One BrowserContext per (browserName, headless, storageStatePath) tuple.
 *   • Contexts are reference-counted so concurrent borrowers don't close them
 *     out from under each other; an idle context is closed after IDLE_TTL_MS.
 *   • Closing the pool tears everything down.
 */

import {
  chromium, firefox, webkit,
  type Browser, type BrowserContext, type LaunchOptions,
} from 'playwright';
import { createLogger } from '../utils/logger.js';

const log = createLogger('context-pool');

export type BrowserName = 'chromium' | 'firefox' | 'webkit';

export interface AcquireOptions {
  browser?: BrowserName;
  headless?: boolean;
  storageStatePath?: string;
  /** Defaults to pathfinder UA + 1280x720 viewport */
  userAgent?: string;
}

interface BrowserSlot {
  browser: Browser;
  refs: number;
}

interface ContextSlot {
  context: BrowserContext;
  key: string;
  refs: number;
  idleTimer?: NodeJS.Timeout;
  browserKey: string;
}

const IDLE_TTL_MS = 60_000; // close an unused context after 60s

const browserSlots = new Map<string, BrowserSlot>();
const contextSlots = new Map<string, ContextSlot>();

const DEFAULT_VIEWPORT = { width: 1280, height: 720 } as const;
const DEFAULT_UA = 'pathfinder/1.0 (AI QA Testing Agent)';

const ENGINES = { chromium, firefox, webkit } as const;

function browserKey(name: BrowserName, headless: boolean): string {
  return `${name}|${headless ? 'headless' : 'headed'}`;
}

function contextKey(name: BrowserName, headless: boolean, storageStatePath?: string): string {
  return `${browserKey(name, headless)}|${storageStatePath ?? ''}`;
}

async function acquireBrowser(name: BrowserName, headless: boolean): Promise<BrowserSlot> {
  const key = browserKey(name, headless);
  const existing = browserSlots.get(key);
  if (existing) {
    existing.refs++;
    return existing;
  }
  const opts: LaunchOptions = { headless };
  const engine = ENGINES[name];
  if (!engine) throw new Error(`Unsupported browser: ${name}`);
  const browser = await engine.launch(opts);
  log.info(`Launched ${name} (headless=${headless})`);
  const slot: BrowserSlot = { browser, refs: 1 };
  browserSlots.set(key, slot);
  return slot;
}

/**
 * Acquire a context. The returned `release()` function decrements the
 * refcount; the context closes after IDLE_TTL_MS once refs reach zero.
 */
export async function acquireContext(opts: AcquireOptions = {}): Promise<{
  context: BrowserContext;
  release: () => void;
}> {
  const name = opts.browser ?? 'chromium';
  const headless = opts.headless ?? true;
  const key = contextKey(name, headless, opts.storageStatePath);

  let slot = contextSlots.get(key);
  if (slot) {
    slot.refs++;
    if (slot.idleTimer) {
      clearTimeout(slot.idleTimer);
      slot.idleTimer = undefined;
    }
    log.info(`Reusing pooled context: ${key} (refs=${slot.refs})`);
    return { context: slot.context, release: () => releaseContext(slot!) };
  }

  const browserSlot = await acquireBrowser(name, headless);
  const ctxOpts: Parameters<typeof browserSlot.browser.newContext>[0] = {
    viewport: DEFAULT_VIEWPORT,
    userAgent: opts.userAgent ?? DEFAULT_UA,
  };
  if (opts.storageStatePath) {
    ctxOpts.storageState = opts.storageStatePath;
    log.info(`Restoring storage state from ${opts.storageStatePath}`);
  }
  const context = await browserSlot.browser.newContext(ctxOpts);
  slot = {
    context,
    key,
    refs: 1,
    browserKey: browserKey(name, headless),
  };
  contextSlots.set(key, slot);
  log.info(`Created pooled context: ${key}`);
  return { context, release: () => releaseContext(slot!) };
}

function releaseContext(slot: ContextSlot): void {
  slot.refs--;
  if (slot.refs > 0) return;
  // Schedule idle close
  slot.idleTimer = setTimeout(() => {
    void closeContextSlot(slot);
  }, IDLE_TTL_MS);
}

async function closeContextSlot(slot: ContextSlot): Promise<void> {
  if (slot.refs > 0) return; // someone re-acquired
  contextSlots.delete(slot.key);
  await slot.context.close().catch(() => {});
  log.info(`Closed idle context: ${slot.key}`);
  // Decrement browser refcount
  const browserSlot = browserSlots.get(slot.browserKey);
  if (!browserSlot) return;
  browserSlot.refs--;
  if (browserSlot.refs <= 0) {
    browserSlots.delete(slot.browserKey);
    await browserSlot.browser.close().catch(() => {});
    log.info(`Closed idle browser: ${slot.browserKey}`);
  }
}

/** Close all pooled contexts and browsers immediately. Call on shutdown. */
export async function closePool(): Promise<void> {
  for (const slot of contextSlots.values()) {
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
    await slot.context.close().catch(() => {});
  }
  contextSlots.clear();
  for (const slot of browserSlots.values()) {
    await slot.browser.close().catch(() => {});
  }
  browserSlots.clear();
  log.info('Context pool drained');
}

/** Inspection / metrics */
export function poolStats(): { browsers: number; contexts: number; refs: Record<string, number> } {
  const refs: Record<string, number> = {};
  for (const [k, v] of contextSlots) refs[k] = v.refs;
  return { browsers: browserSlots.size, contexts: contextSlots.size, refs };
}
