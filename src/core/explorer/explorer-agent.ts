import { scanPage, scanFormFields, scanPageLinks, scanPageMetadata, revealPageContent, getPageSnapshot, selectExplorationTargets, detectModal, scanPageActions, scanDataTables, scanPageType, scanFieldErrors, scanWizardSteps, scanConditionalFields } from './page-scanner';
import {
  createGraph,
  addNode,
  addEdge,
  addFormOutcome,
  saveGraph,
  saveGraphIncremental,
  saveGraphSnapshot,
  loadGraph,
  removeNode,
  pruneStaleNodes,
} from './interaction-graph';
import type { InteractionGraph, InteractiveElement, FormField, FormSubmissionOutcome, ModalDiscovery, ExplorationProgress, ExplorationCoverage, ObservedAPI } from '../../storage/schemas';
import type { AIClientInterface } from '../ai/ai-client';
import { getAgentActions } from './action-ranker';
import { detectSPARoutes } from './spa-detector';
import { sendToContentScript, getActiveTabId } from '../../messaging/messenger';
import { executeStep as executeStepViaPort } from '../step-executor';
import { createMutationLedger } from '../safety/mutation-ledger';
import { describePolicy, isPolicyEmpty, resolvePolicy } from '../safety/policy-resolver';
import { installRunSafety } from '../safety/safety-port';
import { attach, detach, isAttached, startHARCapture, getHAREntries, captureFullPageScreenshot, waitForNetworkIdle, waitForDomSettle } from '../cdp/cdp-client';
import type { HAREntry } from '../cdp/cdp-client';
import { ensureAuthenticated } from '../executor/auth-manager';
import { runAccessibilityAudit } from '../analysis/accessibility-audit';
import type { A11yAuditResult } from '../analysis/accessibility-audit';
import { createLogger } from '../../utils/logger';

const log = createLogger('explorer');

/**
 * Resolve the best human-readable label for a clicked element.
 * Prefers: short visible text > aria-label > AI description > selector.
 * Strips long textContent down to the first meaningful phrase.
 */
function resolveElementLabel(target: { text?: string; ariaLabel?: string; description?: string; selector: string }): string {
  // Prefer aria-label — it's usually a concise, intentional description
  if (target.ariaLabel) return target.ariaLabel;
  // Use visible text if it's short and meaningful (not the full page text bleeding in)
  if (target.text) {
    const cleaned = target.text.replace(/\s+/g, ' ').trim();
    if (cleaned.length > 0 && cleaned.length <= 60) return cleaned;
    // Truncate long text to first phrase
    if (cleaned.length > 60) return cleaned.slice(0, 57) + '...';
  }
  // Fall back to AI description from agent mode
  if (target.description) return target.description;
  return target.selector;
}

/**
 * Fingerprint a page's interactive structure from its elements + form fields.
 * Stable across re-scans when the page is unchanged, so a fresh re-scan can skip
 * the expensive click/modal/form interaction for pages that haven't changed.
 * Uses a cheap synchronous djb2 hash over a canonical signature string.
 */
export function computeStructureFingerprint(elements: InteractiveElement[], formFields: FormField[]): string {
  const elemSig = elements
    .map((e) => `${e.tag}|${e.role ?? ''}|${e.selector}`)
    .sort()
    .join(';');
  const formSig = formFields
    .map((f) => `${f.selector}|${f.type}|${f.required ? 1 : 0}`)
    .sort()
    .join(';');
  const canonical = `${elements.length}#${elemSig}##${formFields.length}#${formSig}`;
  let hash = 5381;
  for (let i = 0; i < canonical.length; i++) {
    hash = ((hash << 5) + hash + canonical.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/**
 * Classify what a click did to the URL:
 *  - 'none'       — URL unchanged (likely opened a modal / did nothing)
 *  - 'in-page'    — same origin + pathname, only query/hash changed (a feature
 *                   tab/panel of the SAME page, e.g. `?aiFeatureTab=overview`)
 *  - 'navigation' — moved to a different page
 */
export function classifyUrlChange(beforeUrl: string, afterUrl: string): 'none' | 'in-page' | 'navigation' {
  if (afterUrl === beforeUrl) return 'none';
  try {
    const a = new URL(beforeUrl);
    const b = new URL(afterUrl);
    if (a.origin === b.origin && a.pathname === b.pathname) return 'in-page';
    return 'navigation';
  } catch {
    return 'navigation';
  }
}

/** Destructive labels to avoid clicking unless includeDangerous is set. */
const DANGEROUS_LABELS = ['delete', 'remove', 'logout', 'sign out', 'cancel subscription'];
function isDangerousLabel(text: string | undefined): boolean {
  const t = (text ?? '').toLowerCase();
  return DANGEROUS_LABELS.some((d) => new RegExp(`\\b${d}\\b`, 'i').test(t));
}

const ACTION_DELAY_MS = 1000;
/** Default number of pages explored in parallel (bounded tab-worker pool). */
const DEFAULT_EXPLORE_CONCURRENCY = 3;
/** Hard cap on parallel exploration tabs — mirrors the executor's 1-4 range. */
const MAX_EXPLORE_CONCURRENCY = 4;
/** Default maximum time to spend on click-exploration per page (ms). */
const DEFAULT_PAGE_EXPLORATION_BUDGET_MS = 90_000; // 90s — override via ExploreOptions.pageBudgetMs
/** Larger budget for the anchored page when exhaustively covering every element. */
const EXHAUSTIVE_PAGE_BUDGET_MS = 300_000; // 5 min
/** Max click targets when exhaustively covering a page. */
const EXHAUSTIVE_TARGET_CAP = 300;
/** Max elements newly revealed by clicks (dropdowns/menus) to follow per page. */
const MAX_REVEALED_PER_PAGE = 150;
/** Timeout for a single exploration click + modal detect cycle (ms). */
const SINGLE_CLICK_TIMEOUT_MS = 20_000;
/**
 * URL patterns that indicate the tester got bounced to an auth wall. When
 * detected mid-exploration we abort and surface a useful error rather than
 * waste cycles clicking the login form.
 */
const AUTH_WALL_RX = /\/(login|signin|sign-in|auth|sso|oauth|session)(?:[/?#]|$)/i;

/**
 * Compute an adaptive delay based on the page's observed load time.
 * Returns a delay between `baseMs` and 3000ms, scaled by the page load time.
 * Falls back to `baseMs` when no load time is available.
 */
function getAdaptiveDelay(baseMs: number, pageLoadTimeMs?: number): number {
  if (!pageLoadTimeMs || pageLoadTimeMs <= 0) return baseMs;
  return Math.min(Math.max(baseMs, Math.round(pageLoadTimeMs * 0.3)), 3000);
}

/**
 * Wait for a tab to become stable after a navigation or interaction.
 *
 * Prefers event-driven signals over a fixed sleep: when CDP is attached (the
 * normal case during exploration) it waits for the network to go quiet and the
 * DOM to settle, so fast pages proceed in a few hundred ms and slow SPAs get up
 * to the ceiling. Falls back to an adaptive fixed delay only when CDP is
 * unavailable for the tab.
 */
async function settle(
  tabId: number,
  opts: { idleMs?: number; timeoutMs?: number; fallbackMs?: number; pageLoadTimeMs?: number } = {},
): Promise<void> {
  const { idleMs = 400, timeoutMs = 8_000, fallbackMs = ACTION_DELAY_MS, pageLoadTimeMs } = opts;
  if (isAttached(tabId)) {
    await waitForNetworkIdle(tabId, { idleMs, timeoutMs });
    await waitForDomSettle(tabId, 2_000);
  } else {
    await delay(getAdaptiveDelay(fallbackMs, pageLoadTimeMs));
  }
}
/** Maximum number of representative pages to explore per URL pattern. */
const MAX_INSTANCES_PER_PATTERN = 2;

// ── URL Pattern Detection ────────────────────────────────────────────────────
// Recognizes dynamic URL segments (numeric IDs, UUIDs, hex hashes, base64-ish
// tokens) and normalizes them to `:param` so the explorer can detect when it's
// seeing the same page template with different data.

/** Patterns that match dynamic URL path segments. */
const DYNAMIC_SEGMENT_PATTERNS = [
  /^[0-9]+$/,                          // Purely numeric IDs: 608205721074453683
  /^[0-9a-f]{8,}$/i,                   // Hex hashes/IDs: a3f4c2d1e5
  /^[0-9a-f]{8}-[0-9a-f]{4}-/i,       // UUIDs: 550e8400-e29b-41d4-...
  /^[A-Za-z0-9_-]{20,}$/,             // Long base64-ish tokens
  /^[0-9]+[a-f0-9]+$/i,               // Mixed numeric + hex (e.g., MongoDB ObjectId)
];

/**
 * Normalize a URL by replacing dynamic path segments with `:param`.
 * Returns the pattern string (origin + normalized path).
 *
 * Example:
 *   /assets/all-assets-list/asset/608205721074453683
 *   → /assets/all-assets-list/asset/:param
 */
export function normalizeUrlPattern(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/');
    const normalized = segments.map((seg) => {
      if (!seg) return seg; // preserve empty segments from leading/trailing slashes
      if (DYNAMIC_SEGMENT_PATTERNS.some((p) => p.test(seg))) return ':param';
      return seg;
    });
    return parsed.origin + normalized.join('/');
  } catch {
    return url;
  }
}

/**
 * Track how many instances of each URL pattern have been visited.
 * Returns true if this URL should be explored (pattern hasn't hit the cap).
 */
export class PatternTracker {
  private counts = new Map<string, number>();

  /** Check if we should explore this URL. Returns the pattern. */
  shouldExplore(url: string): { pattern: string; allowed: boolean } {
    const pattern = normalizeUrlPattern(url);
    const count = this.counts.get(pattern) ?? 0;
    // If the URL IS the pattern (no dynamic segments), always allow
    if (pattern === url) return { pattern, allowed: true };
    return { pattern, allowed: count < MAX_INSTANCES_PER_PATTERN };
  }

  /**
   * Reserve a slot for this URL at ENQUEUE time. Returns false if the pattern
   * is already saturated. Reserving at enqueue (rather than recording at
   * dequeue) prevents queuing many same-pattern instances that would only be
   * discarded later — the cap is enforced before the URL ever enters the queue.
   */
  reserve(url: string): boolean {
    const pattern = normalizeUrlPattern(url);
    if (pattern === url) return true; // no dynamic segment — no cap
    const count = this.counts.get(pattern) ?? 0;
    if (count >= MAX_INSTANCES_PER_PATTERN) return false;
    this.counts.set(pattern, count + 1);
    return true;
  }

  /** Record that a URL with this pattern was visited (used for pre-seeding). */
  record(pattern: string): void {
    this.counts.set(pattern, (this.counts.get(pattern) ?? 0) + 1);
  }

  /** Get the current count for a pattern. */
  count(pattern: string): number {
    return this.counts.get(pattern) ?? 0;
  }
}

export interface ExploreOptions {
  maxDepth?: number;
  maxPages?: number;
  /**
   * Override the starting URL. When not provided the current active tab URL is used.
   * Useful for re-exploring a specific known page.
   */
  startUrl?: string;
  /**
   * When true the node for `startUrl` (and all edges originating from it) are
   * removed from the saved graph before re-scanning so stale data is replaced.
   */
  reexplorePage?: boolean;
  /**
   * When true, start BFS with an empty visited set so previously explored pages
   * are revisited. Use this for a full fresh exploration run.
   */
  fresh?: boolean;
  /**
   * When true, the AI ranks which elements to click on each page based on the
   * accessibility tree, focusing on high-value targets (modals, forms, navigation)
   * and skipping noise. Produces higher-quality graphs. Uses ~1 extra AI call per page.
   * Requires aiClient to be provided.
   */
  agentMode?: boolean;
  /** Required when agentMode is true. */
  aiClient?: AIClientInterface;
  /**
   * When true, destructive buttons (delete/remove/logout/cancel subscription)
   * are included in the click set. Default false — opt in only when you have
   * a sandbox account and want exhaustive coverage.
   */
  includeDangerous?: boolean;
  /**
   * When true, the explorer fills and SUBMITS forms it finds (and submits
   * modal forms) using fabricated test data — which mutates the live app
   * (creates records, sends emails, triggers signups). Default false:
   * read-only exploration that maps forms/fields without submitting. Opt in
   * only against a sandbox/staging account you control.
   */
  submitForms?: boolean;
  /**
   * Optional execution preset providing auth context. When set, an auth-wall
   * hit mid-exploration triggers a re-login attempt instead of aborting.
   */
  executionPresetId?: string;
  /**
   * Run exploration in a dedicated background tab instead of commandeering the
   * user's active tab. Default true.
   */
  useDedicatedTab?: boolean;
  /** Per-page click-exploration time budget in ms. Default 90_000 (90s). */
  pageBudgetMs?: number;
  /**
   * Number of pages to explore in parallel via a bounded tab-worker pool.
   * Clamped to [1, MAX_EXPLORE_CONCURRENCY]. Default 3. Automatically forced to
   * 1 for focused runs (single-page, exhaustive, or maxPages ≤ 1) and whenever
   * a dedicated background tab is not used.
   */
  concurrency?: number;
  /**
   * Whole-run wall-clock budget in ms. When exceeded, the crawl stops cleanly
   * after the current page (partial results are kept and persisted). Default
   * undefined = no wall-clock cap (still bounded by maxPages/maxDepth).
   */
  runBudgetMs?: number;
  /**
   * Capture a full-page screenshot per explored page (stored on the node) so a
   * human can visually verify the map. Opt-in — screenshots are storage-heavy.
   * Requires CDP (auto-attached during exploration).
   */
  captureScreenshots?: boolean;
  /**
   * Exhaustively click EVERY interactive element on the anchored (depth-0) page
   * — bypassing the agent's ranked subset — and capture elements revealed by a
   * click (dropdown menus, expanded panels). Use for focused single-page /
   * "start from this page" runs where full coverage matters more than speed.
   */
  exhaustiveStartPage?: boolean;
  onProgress?: (progress: ExplorationProgress) => void;
  signal?: AbortSignal;
}

export interface ExploreResult {
  graph: InteractionGraph;
  a11yResults: A11yAuditResult[];
  /** Coverage/health summary for the run (pages scanned, failures, untested paths). */
  coverage: ExplorationCoverage;
}

export async function exploreApp(options: ExploreOptions = {}): Promise<ExploreResult> {
  const {
    maxDepth = 5,
    maxPages = 500,
    startUrl: explicitStartUrl,
    reexplorePage = false,
    fresh = false,
    agentMode = true,
    aiClient,
    includeDangerous = false,
    submitForms = false,
    executionPresetId,
    useDedicatedTab = true,
    pageBudgetMs = DEFAULT_PAGE_EXPLORATION_BUDGET_MS,
    runBudgetMs,
    captureScreenshots = false,
    exhaustiveStartPage = false,
    concurrency,
    onProgress,
    signal,
  } = options;
  const runStart = Date.now();
  const useAgentMode = agentMode && !!aiClient;
  // Single-page mode (maxDepth 0): never follow navigation. We still click
  // buttons to reveal modals/panels in place, but skip nav links/tabs/menu
  // items so the tab doesn't navigate away ("no link following").
  const noNavigate = maxDepth === 0;

  let graph = (await loadGraph()) ?? createGraph();
  const a11yResults: A11yAuditResult[] = [];

  // ── Coverage / health accumulator ──────────────────────────────────────────
  // Populated live and finalised at the end so the UI can show real coverage
  // (scanned vs. failed vs. discovered-but-untested) instead of raw counts.
  const coverage: ExplorationCoverage = {
    pagesAttempted: 0,
    pagesScanned: 0,
    pagesFailed: 0,
    untestedPaths: 0,
    brokenLinks: 0,
    coverageRatio: 0,
    // "This page only" (maxDepth 0) maps the anchored page(s) without following
    // links — coverage is measured against that scope, not the whole app.
    singlePage: noNavigate,
    complete: false,
    warnings: [],
  };
  const brokenLinkUrls = new Set<string>();
  const addWarning = (msg: string): void => {
    log.warn(msg);
    if (coverage.warnings.length < 100) coverage.warnings.push(msg);
  };

  // Capture the active tab + its URL up front (before opening background tabs).
  const baseTabId = await getActiveTabId();
  const activeTabUrl = (await chrome.tabs.get(baseTabId).catch(() => undefined))?.url;

  // ── Build the tab-worker pool ───────────────────────────────────────────────
  // Focused runs (single page, exhaustive coverage of one anchored page, or a
  // 1-page cap) stay single-tab for deterministic control. Multi-page crawls
  // fan out across up to MAX_EXPLORE_CONCURRENCY background tabs. Without a
  // dedicated background tab we never commandeer more than the one active tab.
  const singlePageRun = noNavigate || maxPages <= 1 || exhaustiveStartPage;
  const requestedConcurrency = singlePageRun ? 1 : (concurrency ?? DEFAULT_EXPLORE_CONCURRENCY);
  const workerCount = useDedicatedTab
    ? Math.max(1, Math.min(MAX_EXPLORE_CONCURRENCY, requestedConcurrency))
    : 1;

  interface ExploreWorker { tabId: number; dedicated: boolean; }
  const workers: ExploreWorker[] = [];
  const dedicatedTabIds: number[] = [];
  if (useDedicatedTab) {
    for (let i = 0; i < workerCount; i++) {
      try {
        const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
        if (tab.id === undefined) continue;
        dedicatedTabIds.push(tab.id);
        workers.push({ tabId: tab.id, dedicated: true });
      } catch (err) {
        log.warn('Could not open dedicated exploration tab', err);
      }
    }
  }
  // Fallback (or non-dedicated mode): drive the active tab directly.
  if (workers.length === 0) workers.push({ tabId: baseTabId, dedicated: false });
  log.info(`Exploration pool: ${workers.length} tab(s)`);

  // ── Attach CDP per worker tab (HAR capture + network-idle stability waits) ──
  for (const w of workers) {
    try {
      await attach(w.tabId);
      await startHARCapture(w.tabId);
    } catch {
      log.info(`CDP unavailable on tab ${w.tabId} — API capture / network-idle waits disabled there`);
    }
  }
  const primaryTabId = workers[0].tabId;

  // ── Determine start URL ─────────────────────────────────────────────────────
  let startUrl: string;
  if (explicitStartUrl) {
    startUrl = explicitStartUrl;
    await navigateToUrl(primaryTabId, startUrl);
    await settle(primaryTabId);
  } else {
    // No explicit start — use the URL the user had open. Dedicated tabs start on
    // about:blank so we must navigate the primary there.
    startUrl = activeTabUrl ?? '';
    if (workers[0].dedicated && startUrl) {
      await navigateToUrl(primaryTabId, startUrl);
      await settle(primaryTabId);
    }
  }

  // ── Same-origin guard ───────────────────────────────────────────────────────
  let startOrigin = '';
  try {
    startOrigin = new URL(startUrl).origin;
  } catch {
    // non-standard URL — allow without constraint
  }

  // ── §7 request enforcement, per worker tab ──────────────────────────────────
  // Installed here rather than at attach time because the allowlist derives from
  // startUrl, which is only known now. `submitForms` is the existing, explicit
  // mutation opt-in, so it maps directly onto the method gate: a read-only
  // exploration cannot issue a POST even if the app's own JS tries.
  const explorePolicy = resolvePolicy({
    startUrl,
    allowMutations: submitForms,
  });
  const exploreLedger = createMutationLedger();
  const safetyHandles: Array<{ dispose(): Promise<void> }> = [];
  if (isPolicyEmpty(explorePolicy)) {
    log.warn(
      `Could not resolve an origin from "${startUrl}" — request enforcement is NOT active for this exploration.`
    );
  } else {
    for (const w of workers) {
      const handle = await installRunSafety(w.tabId, explorePolicy, exploreLedger).catch((err) => {
        log.warn(`Could not install request enforcement on tab ${w.tabId}`, err);
        return null;
      });
      if (handle) safetyHandles.push(handle);
    }
    log.info(
      `Exploration enforcement: ${describePolicy(explorePolicy)} across ${safetyHandles.length} tab(s)`
    );
  }

  // ── Re-explore: snapshot first, then wipe stale data for this page ──────────
  if (reexplorePage && explicitStartUrl) {
    await saveGraphSnapshot(`before re-explore: ${explicitStartUrl}`);
    removeNode(graph, explicitStartUrl);
    await saveGraph(graph);
    log.info(`Re-exploring page: ${explicitStartUrl}`);
  }

  // ── URL pattern deduplication ──────────────────────────────────────────────
  // Recognizes parameterized routes (e.g. /asset/:id) and caps exploration
  // to MAX_INSTANCES_PER_PATTERN representative pages per pattern.
  const patternTracker = new PatternTracker();

  // ── Seed the BFS queue ──────────────────────────────────────────────────────
  // fresh=true (full re-exploration) or reexplorePage=true (single page) both
  // start with an empty visited set so previously seen URLs are revisited.
  const visitedUrls = new Set<string>(
    fresh || reexplorePage ? [] : graph.nodes.map((n) => n.url)
  );
  // Pages actually re-scanned during this run. On a fresh run, any pre-existing
  // node NOT in this set is stale (deleted / no longer reachable) and is pruned.
  const seenThisRun = new Set<string>();
  // Per-page visited selectors — scoped by URL so the same selector on
  // different pages is explored independently.
  const visitedSelectorsPerPage = new Map<string, Set<string>>();
  /** Get or create the visited-selector set for a given page URL. */
  const getVisitedForPage = (pageUrl: string): Set<string> => {
    let set = visitedSelectorsPerPage.get(pageUrl);
    if (!set) { set = new Set<string>(); visitedSelectorsPerPage.set(pageUrl, set); }
    return set;
  };
  const queue: Array<{ url: string; depth: number }> = [{ url: startUrl, depth: 0 }];
  // URLs already placed in the queue. Prevents enqueueing — and double-reserving
  // a pattern slot for — the same URL discovered from multiple sources.
  const queuedUrls = new Set<string>([startUrl]);
  /** Reserve a pattern slot and enqueue a URL once. Returns true if enqueued. */
  const tryEnqueue = (url: string, depth: number): boolean => {
    if (visitedUrls.has(url) || queuedUrls.has(url)) return false;
    if (!patternTracker.reserve(url)) return false;
    queue.push({ url, depth });
    queuedUrls.add(url);
    return true;
  };
  // Guard so auth recovery is attempted at most once per run (avoids loops).
  let authRecoveryAttempted = false;

  // Pre-seed tracker from existing graph nodes so we don't revisit patterns
  // that were already explored in a previous run.
  if (!fresh) {
    for (const node of graph.nodes) {
      const pattern = normalizeUrlPattern(node.url);
      if (pattern !== node.url) patternTracker.record(pattern);
    }
  }

  // ── SPA route seeding ────────────────────────────────────────────────────
  // Read framework-level route manifests (Next.js __BUILD_MANIFEST, Nuxt
  // __NUXT__, nav DOM links) to seed the BFS queue with routes that would
  // otherwise only be reachable via JS navigation, not plain <a href> links.
  // Runs on the primary tab (already on the origin). Skipped for single-page.
  if (startOrigin && maxDepth > 0) {
    try {
      const spaRoutes = await detectSPARoutes(primaryTabId, startOrigin);
      if (spaRoutes.length > 0) {
        log.info(`SPA detector seeded ${spaRoutes.length} routes into BFS queue`);
        for (const routeUrl of spaRoutes) tryEnqueue(routeUrl, 1);
      }
    } catch { /* non-fatal — SPA seeding is best-effort */ }
  }

  // ── Serialize graph persistence across workers (last write wins, no clobber) ─
  let saveChain: Promise<void> = Promise.resolve();
  const persist = (fn: () => Promise<void>): Promise<void> => {
    saveChain = saveChain.then(fn).catch((err) => log.debug('graph persist failed', err));
    return saveChain;
  };

  // ── Coverage helpers ─────────────────────────────────────────────────────────
  /** Discovered destination URLs we never mapped and aren't known broken links. */
  const countUntestedPaths = (): number => {
    const nodeUrls = new Set(graph.nodes.map((n) => n.url));
    let n = 0;
    for (const to of new Set(graph.edges.map((e) => e.to))) {
      if (!nodeUrls.has(to) && !brokenLinkUrls.has(to)) n++;
    }
    return n;
  };
  /**
   * Coverage ratio, interpreted relative to scope. Single-page runs measure how
   * much of the intended scope (the anchored page[s]) was scanned — the links
   * they surface are next-step hints, not gaps. Crawl runs measure how much of
   * everything discovered was mapped.
   */
  const computeCoverageRatio = (): number => {
    if (noNavigate) {
      return coverage.pagesAttempted === 0 ? 1 : coverage.pagesScanned / coverage.pagesAttempted;
    }
    const mapped = graph.nodes.length;
    const denom = mapped + coverage.untestedPaths;
    return denom === 0 ? 1 : mapped / denom;
  };
  const emitProgress = (currentPage: string, status: ExplorationProgress['status']): void => {
    coverage.untestedPaths = countUntestedPaths();
    coverage.brokenLinks = brokenLinkUrls.size;
    coverage.coverageRatio = computeCoverageRatio();
    onProgress?.({
      pagesVisited: visitedUrls.size,
      elementsFound: graph.nodes.reduce((sum, n) => sum + n.elementCount, 0),
      edgesRecorded: graph.edges.length,
      currentPage,
      status,
      coverage: { ...coverage, warnings: [...coverage.warnings] },
    });
  };

  // ── Per-page processing (runs on a worker's own tab) ─────────────────────────
  async function processPage(w: ExploreWorker, entry: { url: string; depth: number }): Promise<void> {
    const { tabId } = w;
    const cdpAvailable = isAttached(tabId);
    const { url, depth } = entry;
    const urlPattern = normalizeUrlPattern(url);

    const navStart = Date.now();
    await navigateToUrl(tabId, url);
    const pageLoadTimeMs = Date.now() - navStart;
    // Wait for the network to go quiet + DOM to settle instead of a flat sleep.
    await settle(tabId, { idleMs: 400, fallbackMs: 300, pageLoadTimeMs });

    // ── 1. Reveal hidden content (hover nav, scroll lazy sections) ────────────
    await revealPageContent(tabId);

    // ── 2. Read live page state. A null snapshot means the content script never
    // answered (injection failed / hard navigation error) — a SCAN FAILURE, not
    // an empty page. Retry once, then record it and skip so the user can tell
    // "we scanned an empty page" apart from "the scan failed".
    let snapshot = await getPageSnapshot(tabId);
    if (!snapshot) {
      await settle(tabId, { idleMs: 300, timeoutMs: 3_000, fallbackMs: 500 });
      snapshot = await getPageSnapshot(tabId);
    }
    if (!snapshot) {
      coverage.pagesFailed++;
      addWarning(`Scan failed (content script unavailable): ${url}`);
      return;
    }

    const currentUrl = snapshot.url ?? url;
    // document.title is often stale in SPAs; fall back to the first heading.
    let currentTitle = snapshot.title ?? '';
    if (!currentTitle || currentTitle === '...' || currentTitle === 'about:blank') {
      const earlyMeta = await scanPageMetadata(tabId);
      if (earlyMeta.headings.length > 0) currentTitle = earlyMeta.headings[0];
    }

    // Skip pages that navigated outside the origin.
    if (startOrigin && !currentUrl.startsWith(startOrigin)) {
      log.debug(`Skipping off-origin navigation: ${currentUrl}`);
      return;
    }

    // Auth-wall guard — bounced to /login mid-run (session expired / logout).
    const startedOnAuthPage = AUTH_WALL_RX.test(startUrl);
    if (!startedOnAuthPage && AUTH_WALL_RX.test(currentUrl)) {
      if (executionPresetId && !authRecoveryAttempted) {
        authRecoveryAttempted = true;
        addWarning(`Auth wall at ${currentUrl} — attempting session recovery via preset.`);
        const authResult = await ensureAuthenticated(tabId, executionPresetId, url).catch(() => null);
        if (authResult?.authenticated) {
          log.info(`Session recovered via ${authResult.method} — re-queuing ${url}.`);
          // Re-queue this page; a worker will re-scan it. Undo the attempt count.
          visitedUrls.delete(url);
          coverage.pagesAttempted--;
          queue.unshift({ url, depth });
          return;
        }
      }
      // Unrecoverable — signal the whole run to stop (handled in runWorker).
      throw new Error(`Exploration hit an auth wall at ${currentUrl}. Sign in to the app and re-run exploration.`);
    }

    // ── 3. Scan elements + forms + links + metadata + detectors in parallel ──
    const harBefore = cdpAvailable ? getHAREntries(tabId).length : 0;
    const [elements, formFields, hrefLinks, pageMetadata, pageActions, dataTables, pageTypeInfo, wizardSteps, conditionalFields] = await Promise.all([
      scanPage(tabId),
      scanFormFields(tabId),
      startOrigin ? scanPageLinks(tabId, startOrigin) : Promise.resolve([] as Array<{ url: string; text: string }>),
      scanPageMetadata(tabId),
      scanPageActions(tabId),
      scanDataTables(tabId),
      scanPageType(tabId),
      scanWizardSteps(tabId),
      scanConditionalFields(tabId),
    ]);

    // ── 3a. Broken/error page — record as a broken link, don't map it ──
    if (pageTypeInfo.isErrorPage) {
      brokenLinkUrls.add(currentUrl);
      addWarning(`Broken/error page (${pageTypeInfo.httpStatus ?? 'unknown status'}): ${currentUrl}`);
      return;
    }

    coverage.pagesScanned++;

    const priorStructureHash = graph.nodes.find((n) => n.url === currentUrl)?.structureHash;
    const structureHash = computeStructureFingerprint(elements, formFields);
    const structureUnchanged = fresh && !!priorStructureHash && priorStructureHash === structureHash;

    const node = addNode(graph, currentUrl, currentTitle, elements.length, formFields);
    node.structureHash = structureHash;
    seenThisRun.add(currentUrl);

    if (pageMetadata.breadcrumb) node.breadcrumb = pageMetadata.breadcrumb;
    if (pageMetadata.headings.length > 0) node.headings = pageMetadata.headings;
    node.pageType = pageTypeInfo.pageType;
    node.isErrorPage = pageTypeInfo.isErrorPage || undefined;
    node.httpStatus = pageTypeInfo.httpStatus;
    if (pageActions.length > 0) node.actions = pageActions;
    if (dataTables.length > 0) node.dataTables = dataTables;
    if (urlPattern !== currentUrl) node.urlPattern = urlPattern;
    node.loadTimeMs = pageLoadTimeMs;

    if (captureScreenshots && cdpAvailable) {
      try {
        const shot = await captureFullPageScreenshot(tabId);
        if (shot) node.screenshot = shot;
      } catch { /* non-fatal — visual capture is best-effort */ }
    }
    if (wizardSteps.length > 0) node.wizardSteps = wizardSteps;
    if (conditionalFields.length > 0 && node.formFields) {
      for (const rule of conditionalFields) {
        const field = node.formFields.find((f) => f.selector === rule.fieldSelector);
        if (field) field.visibleWhen = { fieldSelector: rule.triggerSelector, fieldValue: rule.triggerValue };
      }
    }

    // ── 3b. API endpoints + 3c. a11y audit (CDP only) ──
    if (cdpAvailable) {
      const pageLoadEntries = getHAREntries(tabId).slice(harBefore);
      const apiEndpoints = extractAPIEndpoints(pageLoadEntries, 'page_load');
      if (apiEndpoints.length > 0) node.apiEndpoints = [...(node.apiEndpoints ?? []), ...apiEndpoints];
      try {
        const a11yResult = await runAccessibilityAudit(tabId, currentUrl, currentTitle);
        if (a11yResult.issues.length > 0) {
          a11yResults.push(a11yResult);
          log.info(`A11y: ${a11yResult.summary.total} issues on "${currentTitle || currentUrl}" (${a11yResult.summary.critical} critical)`);
        }
      } catch { /* non-fatal — a11y audit failure shouldn't block exploration */ }
    }

    emitProgress(currentTitle || currentUrl, 'running');

    // ── 4. Enqueue discovered href links (depth-independent) ─────────────
    for (const link of hrefLinks) {
      const change = classifyUrlChange(currentUrl, link.url);
      if (change === 'in-page') {
        if (!node.tabs) node.tabs = [];
        if (!node.tabs.some((t) => t.url === link.url)) node.tabs.push({ label: link.text || link.url, url: link.url });
        continue;
      }
      if (change === 'navigation' && !visitedUrls.has(link.url)) {
        addEdge(graph, currentUrl, link.url, 'link', 'a[href]', link.text);
        if (depth < maxDepth) tryEnqueue(link.url, depth + 1);
      }
    }

    // Fast path: skip interaction for pages whose structure is unchanged.
    if (structureUnchanged) {
      log.info(`Structure unchanged — skipping interaction on "${currentTitle || currentUrl}"`);
      await persist(() => saveGraphIncremental(graph));
      return;
    }

    // Exhaustive coverage applies to the anchored (depth-0) page only.
    const exhaustiveThisPage = exhaustiveStartPage && depth === 0;

    // ── 5. Click-based discovery for JS-only navigation ──────────────────
    let targets: Array<{ selector: string; text?: string; ariaLabel?: string; description?: string }>;
    if (exhaustiveThisPage) {
      targets = selectExplorationTargets(elements, getVisitedForPage(currentUrl), { includeDangerous, maxTargets: EXHAUSTIVE_TARGET_CAP });
      log.info(`Exhaustive mode: clicking all ${targets.length} interactive elements on "${currentTitle || currentUrl}"`);
    } else if (useAgentMode) {
      const agentActions = await getAgentActions(currentUrl, currentTitle, elements, visitedUrls, getVisitedForPage(currentUrl), aiClient!);
      if (agentActions.length === 0) {
        log.info(`Agent mode: no high-value actions on "${currentTitle || currentUrl}" — using standard fallback`);
        targets = selectExplorationTargets(elements, getVisitedForPage(currentUrl), { includeDangerous });
      } else {
        log.info(`Agent mode: clicking ${agentActions.length} AI-ranked elements on "${currentTitle || currentUrl}"`);
        targets = agentActions.map((a) => {
          const matchedEl = elements.find((el) => el.selector === a.selector);
          return { selector: a.selector, text: matchedEl?.text || undefined, ariaLabel: matchedEl?.ariaLabel || undefined, description: a.description };
        });
      }
    } else {
      targets = selectExplorationTargets(elements, getVisitedForPage(currentUrl), { includeDangerous });
    }

    const pageExplorationStart = Date.now();
    const effectivePageBudget = exhaustiveThisPage ? EXHAUSTIVE_PAGE_BUDGET_MS : pageBudgetMs;
    // Selectors known before each click — used to detect elements REVEALED by a
    // click (dropdown menus, expanded panels) so we can click those too.
    const knownSelectors = new Set(elements.map((e) => e.selector));
    let revealedCount = 0;

    for (let ti = 0; ti < targets.length; ti++) {
      const target = targets[ti];
      if (signal?.aborted) break;
      if (Date.now() - pageExplorationStart > effectivePageBudget) {
        log.info(`Page exploration budget exceeded on ${currentUrl}, moving on (${ti}/${targets.length} targets explored)`);
        break;
      }

      const pageVisited = getVisitedForPage(currentUrl);
      if (pageVisited.has(target.selector)) continue;

      // Single-page mode: don't click pure-navigation targets (links/menu items).
      if (noNavigate) {
        const scanned = elements.find((e) => e.selector === target.selector);
        if (scanned && (scanned.tag === 'a' || scanned.role === 'link' || scanned.role === 'menuitem')) {
          pageVisited.add(target.selector);
          log.debug(`Single-page mode: skipping navigation target ${target.selector}`);
          continue;
        }
      }

      pageVisited.add(target.selector);
      log.info(`Clicking target ${ti + 1}/${targets.length} on "${currentTitle || currentUrl}": ${target.description ?? target.selector}`);

      try {
        // Tracks whether the click kept us on the same page (vs navigating /
        // switching tab view) — only then can a dropdown/menu have been revealed.
        let stayedOnPage = true;
        await withTimeout(SINGLE_CLICK_TIMEOUT_MS, async () => {
          const beforeUrl = currentUrl;
          await executeStepViaPort({ order: 0, action: 'click', selector: target.selector, description: `Explore: ${resolveElementLabel(target)}` }, tabId);

          // Wait for any click-triggered XHR/route change to settle.
          await settle(tabId, { idleMs: 350 });

          const afterSnap = await getPageSnapshot(tabId);
          const afterUrl = afterSnap?.url ?? currentUrl;
          const change = classifyUrlChange(beforeUrl, afterUrl);

          if (change === 'in-page') {
            stayedOnPage = false;
            const label = resolveElementLabel(target);
            if (!node.tabs) node.tabs = [];
            if (!node.tabs.some((t) => t.url === afterUrl)) {
              node.tabs.push({ label, url: afterUrl });
              log.info(`In-page view discovered via "${label}" on ${currentUrl}`);
            }
            await navigateToUrl(tabId, beforeUrl);
            await settle(tabId);
          } else if (change === 'navigation') {
            stayedOnPage = false;
            if (startOrigin && !afterUrl.startsWith(startOrigin)) {
              await navigateToUrl(tabId, beforeUrl);
              await settle(tabId);
              return;
            }
            addEdge(graph, beforeUrl, afterUrl, 'click', target.selector, resolveElementLabel(target));
            if (depth < maxDepth) tryEnqueue(afterUrl, depth + 1);
            await navigateToUrl(tabId, beforeUrl);
            await settle(tabId);
          } else {
            // Click didn't navigate — check if a modal/dialog opened.
            const modal = await detectModal(tabId);
            if (modal.found) {
              const hasContent = !!(modal.title?.trim()) || (modal.formFields && modal.formFields.length > 0);
              if (hasContent) {
                const discovery: ModalDiscovery = {
                  triggerSelector: target.selector,
                  triggerLabel: resolveElementLabel(target),
                  title: modal.title,
                  formFields: modal.formFields,
                  content: modal.content?.slice(0, 300),
                };
                // Submit the modal form to capture outcomes — gated behind
                // submitForms since it mutates the live app.
                if (submitForms && modal.formFields && modal.formFields.length > 0) {
                  try {
                    const modalElements = await scanPage(tabId);
                    const modalSubmit = findSubmitButton(modalElements);
                    if (modalSubmit) {
                      await executeStepViaPort({ order: 0, action: 'click', selector: modalSubmit.selector, description: 'Explore: modal empty submit' }, tabId);
                      await settle(tabId);
                      const outcome = await captureFormOutcome(tabId, currentUrl, [], modalSubmit.selector);
                      discovery.formOutcome = outcome;
                      log.info(`Modal form outcome: ${outcome.result} via "${discovery.triggerLabel}"`);
                    }
                  } catch (modalErr) {
                    addWarning(`Modal form exploration failed on ${currentUrl} (${target.selector}): ${modalErr instanceof Error ? modalErr.message : String(modalErr)}`);
                  }
                }
                if (!node.modals) node.modals = [];
                if (!node.modals.some((m) => m.triggerSelector === target.selector)) {
                  node.modals.push(discovery);
                  log.info(`Modal discovered via "${discovery.triggerLabel}" on ${currentUrl}`);
                }
              }
              await dismissModalSafe(tabId);
            }
          }
        });

        // ── Reveal capture (all modes) ────────────────────────────────────
        // If the click stayed on the page, re-scan for elements it REVEALED
        // (dropdown menu items, expanded panels) and queue them so menu-nested
        // actions get covered — not just in exhaustive mode.
        if (stayedOnPage && revealedCount < MAX_REVEALED_PER_PAGE) {
          const afterEls = await scanPage(tabId).catch(() => [] as InteractiveElement[]);
          let added = 0;
          for (const el of afterEls) {
            if (revealedCount >= MAX_REVEALED_PER_PAGE) break;
            if (knownSelectors.has(el.selector)) continue;
            knownSelectors.add(el.selector);
            const clickable =
              el.tag === 'button' || el.tag === 'a' ||
              el.role === 'button' || el.role === 'menuitem' || el.role === 'tab' || el.role === 'option' || el.role === 'link';
            if (!clickable) continue;
            if (!includeDangerous && isDangerousLabel(el.text)) continue;
            targets.push({ selector: el.selector, text: el.text || undefined, ariaLabel: el.ariaLabel || undefined });
            revealedCount++;
            added++;
          }
          if (added > 0) {
            log.info(`Revealed ${added} new element(s) via "${resolveElementLabel(target)}" — queued for exploration`);
            await dismissModalSafe(tabId); // close the menu so the next click starts clean
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('timeout') || msg.includes('Timeout')) {
          log.debug(`Exploration click timed out: ${target.selector}`);
          try { await navigateToUrl(tabId, currentUrl); await settle(tabId); } catch { /* non-fatal */ }
        } else {
          log.debug(`Element interaction failed: ${target.selector}`, err);
        }
      }
    }

    // ── 6. Form interaction discovery (mutates app — gated behind submitForms) ──
    if (submitForms && formFields.length > 0 && depth <= maxDepth) {
      try {
        await exploreFormSubmission(tabId, currentUrl, formFields, elements, graph);
        await navigateToUrl(tabId, currentUrl);
        await settle(tabId);
      } catch (err) {
        addWarning(`Form exploration failed on ${currentUrl}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await persist(() => saveGraphIncremental(graph));
  }

  // ── Worker pool over the shared BFS queue ────────────────────────────────────
  // Each worker owns its own tab. dequeueNext() reserves the visited slot
  // synchronously (JS is single-threaded between awaits) so two workers never
  // grab the same URL. The pool drains when the queue is empty AND no worker is
  // mid-page — a busy worker may still enqueue newly-discovered links.
  let activeWorkers = 0;
  let stopReason: Error | null = null;
  const budgetExceeded = (): boolean => !!runBudgetMs && Date.now() - runStart > runBudgetMs;

  const dequeueNext = (): { url: string; depth: number } | null => {
    while (queue.length > 0) {
      if (visitedUrls.size >= maxPages) return null;
      const entry = queue.shift()!;
      if (visitedUrls.has(entry.url)) continue;
      visitedUrls.add(entry.url);
      coverage.pagesAttempted++;
      return entry;
    }
    return null;
  };

  async function runWorker(w: ExploreWorker): Promise<void> {
    for (;;) {
      if (signal?.aborted || stopReason) return;
      if (budgetExceeded()) {
        log.warn(`Run wall-clock budget (${runBudgetMs}ms) exceeded after ${visitedUrls.size} pages — stopping worker.`);
        return;
      }
      const entry = dequeueNext();
      if (!entry) {
        if (activeWorkers === 0) return; // queue empty and nobody can add more
        await delay(50);
        continue;
      }
      activeWorkers++;
      try {
        await processPage(w, entry);
      } catch (err) {
        // Fail loudly: record the per-page failure rather than swallowing it.
        const e = err instanceof Error ? err : new Error(String(err));
        coverage.pagesFailed++;
        addWarning(`Exploration failed for ${entry.url}: ${e.message}`);
        // A hard auth wall is fatal for the whole run — signal all workers.
        if (e.message.includes('auth wall')) stopReason = e;
      } finally {
        activeWorkers--;
      }
    }
  }

  await Promise.all(workers.map((w) => runWorker(w)));

  // ── Stale-page pruning (fresh + naturally-complete run only) ──────────────
  // Any pre-existing node we didn't re-see is gone from the app — prune it.
  // Snapshot first so the removal is reversible. Skipped when the run was
  // truncated (maxPages / budget / abort / auth wall) since incomplete coverage
  // would cause false deletes.
  // Hitting the page cap counts as truncation only for crawl runs — for a
  // single-page run, mapping the one intended page IS completion, not a cutoff.
  const hitPageCap = visitedUrls.size >= maxPages;
  const truncated =
    !!signal?.aborted || budgetExceeded() || queue.length > 0 || !!stopReason || (hitPageCap && !noNavigate);
  const runCompleted = !truncated;
  if (fresh && runCompleted) {
    const stale = graph.nodes.filter((n) => !seenThisRun.has(n.url)).map((n) => n.url);
    if (stale.length > 0) {
      await saveGraphSnapshot(`before pruning ${stale.length} stale page(s)`);
      const removed = pruneStaleNodes(graph, seenThisRun);
      log.info(`Pruned ${removed.length} stale page(s) no longer reachable: ${removed.slice(0, 5).join(', ')}${removed.length > 5 ? '…' : ''}`);
    }
  }

  // ── Final full save (flush any queued incremental saves first) ────────────
  await saveChain;
  await persist(() => saveGraph(graph));
  await saveChain;

  // ── Dispose enforcement, detach CDP, close dedicated tabs ─────────────────
  // Enforcement first: the Fetch listener must go before the session it watches
  // (CLAUDE.md §11.1 — an orphaned listener is a leak).
  for (const handle of safetyHandles) {
    try { await handle.dispose(); } catch { /* non-fatal */ }
  }
  const exploreLedgerSummary = exploreLedger.summary();
  if (exploreLedgerSummary.mutationsPermitted > 0 || exploreLedgerSummary.requestsRefused > 0) {
    log.info(
      `Exploration changed ${exploreLedgerSummary.mutationsPermitted} endpoint(s); ` +
        `refused ${exploreLedgerSummary.requestsRefused} request(s) ` +
        `(${exploreLedgerSummary.refusedByOrigin} off-allowlist, ` +
        `${exploreLedgerSummary.refusedByMethod} blocked verb)`
    );
    if (exploreLedgerSummary.changedEndpoints.length > 0) {
      log.warn(`Endpoints this exploration wrote to: ${exploreLedgerSummary.changedEndpoints.join(', ')}`);
    }
  }

  for (const w of workers) {
    if (isAttached(w.tabId)) {
      try { await detach(w.tabId); } catch { /* non-fatal */ }
    }
  }
  for (const id of dedicatedTabIds) {
    try { await chrome.tabs.remove(id); } catch { /* tab may already be closed */ }
  }

  // ── Finalise coverage ─────────────────────────────────────────────────────
  coverage.untestedPaths = countUntestedPaths();
  coverage.brokenLinks = brokenLinkUrls.size;
  coverage.coverageRatio = computeCoverageRatio();
  coverage.complete = runCompleted;
  log.info(
    `Coverage: ${coverage.pagesScanned} scanned, ${coverage.pagesFailed} failed, ` +
    `${coverage.untestedPaths} untested path(s), ${coverage.brokenLinks} broken link(s), ` +
    `ratio=${(coverage.coverageRatio * 100).toFixed(0)}%${runCompleted ? '' : ' (partial run)'}`,
  );

  emitProgress('', stopReason ? 'error' : 'done');

  if (stopReason) throw stopReason;
  return { graph, a11yResults, coverage };
}

/**
 * Try submitting a form with empty fields first (to discover validation errors),
 * then with placeholder/test data (to discover success states).
 */
async function exploreFormSubmission(
  tabId: number,
  pageUrl: string,
  formFields: FormField[],
  elements: InteractiveElement[],
  graph: InteractionGraph
): Promise<void> {
  const submitButton = findSubmitButton(elements);
  if (!submitButton) return;
  const cdpOn = isAttached(tabId);

  // ── Attempt 1: Empty submission — discover required field validation ──
  try {
    const harBefore = cdpOn ? getHAREntries(tabId).length : 0;
    await executeStepViaPort({ order: 0, action: 'click', selector: submitButton.selector, description: 'Explore: empty form submit' }, tabId);
    await settle(tabId);

    const outcome = await captureFormOutcome(tabId, pageUrl, [], submitButton.selector);
    addFormOutcome(graph, pageUrl, outcome);

    // Capture API endpoints triggered by the form submission
    if (cdpOn) {
      const formApis = extractAPIEndpoints(getHAREntries(tabId).slice(harBefore), 'form_submit');
      const node = graph.nodes.find((n) => n.url === pageUrl);
      if (node && formApis.length > 0) {
        node.apiEndpoints = [...(node.apiEndpoints ?? []), ...formApis];
      }
    }

    // Navigate back if submission caused navigation
    const afterSnap = await getPageSnapshot(tabId);
    if (afterSnap && afterSnap.url !== pageUrl) {
      await navigateToUrl(tabId, pageUrl);
      await settle(tabId);
    }
  } catch (err) {
    log.debug('Empty form submission exploration failed', err);
  }

  // ── Attempt 2: Fill all fields (required first, then optional) with test data, then submit ──
  // Filling all fields captures the full form submission experience — including
  // conditional fields that appear only after other fields are filled.
  const fieldsToFill = [
    ...formFields.filter((f) => f.required),
    ...formFields.filter((f) => !f.required),
  ];
  if (fieldsToFill.length === 0) return;

  try {
    const filledSelectors: string[] = [];
    for (const field of fieldsToFill) {
      const testValue = generateTestValue(field);
      if (!testValue) continue;

      // Use appropriate action based on field type
      const action = (field.type === 'select') ? 'select'
        : (field.type === 'checkbox' || field.type === 'radio') ? 'check'
        : 'type';

      await executeStepViaPort({
          order: 0,
          action,
          selector: field.selector,
          value: action === 'check' ? undefined : testValue,
          description: `Explore: fill ${field.label || field.name || field.type}`,
        }, tabId);
      filledSelectors.push(field.selector);
      await delay(300);
    }

    if (filledSelectors.length > 0) {
      const harBeforeFilled = cdpOn ? getHAREntries(tabId).length : 0;
      await executeStepViaPort({ order: 0, action: 'click', selector: submitButton.selector, description: 'Explore: filled form submit' }, tabId);
      await settle(tabId);

      const outcome = await captureFormOutcome(tabId, pageUrl, filledSelectors, submitButton.selector);
      addFormOutcome(graph, pageUrl, outcome);

      // Capture API endpoints triggered by filled form submission
      if (cdpOn) {
        const formApis = extractAPIEndpoints(getHAREntries(tabId).slice(harBeforeFilled), 'form_submit');
        const node = graph.nodes.find((n) => n.url === pageUrl);
        if (node && formApis.length > 0) {
          node.apiEndpoints = [...(node.apiEndpoints ?? []), ...formApis];
        }
      }
    }
  } catch (err) {
    log.debug('Filled form submission exploration failed', err);
  }
}

export function findSubmitButton(elements: InteractiveElement[]): InteractiveElement | undefined {
  // Priority: submit buttons → buttons with submit-like text
  const submitInput = elements.find(
    (el) => (el.tag === 'button' || el.tag === 'input') && el.type === 'submit' && el.visible
  );
  if (submitInput) return submitInput;

  const submitText = ['submit', 'save', 'create', 'add', 'send', 'register', 'sign up', 'log in', 'login', 'continue', 'next', 'confirm'];
  return elements.find((el) => {
    if (el.tag !== 'button' || !el.visible) return false;
    const text = (el.text ?? '').toLowerCase();
    return submitText.some((st) => text.includes(st));
  });
}

async function captureFormOutcome(
  tabId: number,
  originalUrl: string,
  filledFields: string[],
  submitSelector: string
): Promise<FormSubmissionOutcome> {
  const snapshot = await getPageSnapshot(tabId);
  const currentUrl = snapshot?.url ?? originalUrl;

  // Check for navigation
  if (currentUrl !== originalUrl) {
    return {
      filledFields,
      submitSelector,
      result: 'navigation',
      resultUrl: currentUrl,
    };
  }

  // Look for error/success messages in the DOM — check immediately and again
  // after a short delay to catch toast/snackbar animations that appear async.
  let messageInfo = await detectFormMessages(tabId);

  if (!messageInfo.hasError && !messageInfo.hasSuccess) {
    // Many UI frameworks show toasts/snackbars after a short async delay. Let
    // the network/DOM settle (bounded) before re-checking rather than a flat
    // sleep, then re-detect.
    await settle(tabId, { idleMs: 300, timeoutMs: 3_000, fallbackMs: 800 });
    messageInfo = await detectFormMessages(tabId);
  }

  if (messageInfo.hasError) {
    // Capture per-field error mapping for downstream test assertions
    const fieldErrors = await scanFieldErrors(tabId);
    return {
      filledFields,
      submitSelector,
      result: 'validation_error',
      resultMessage: messageInfo.message,
      errorSelectors: messageInfo.selectors,
      fieldErrors: fieldErrors.length > 0 ? fieldErrors : undefined,
    };
  }

  if (messageInfo.hasSuccess) {
    return {
      filledFields,
      submitSelector,
      result: 'success',
      resultMessage: messageInfo.message,
    };
  }

  // Last resort: check if the form fields were cleared after submission
  // (a common pattern — the form resets on success without showing a message)
  if (filledFields.length > 0) {
    try {
      const currentFormFields = await scanFormFields(tabId);
      const wasCleared = filledFields.every((filledSelector) => {
        const field = currentFormFields.find((f) => f.selector === filledSelector);
        // If the field no longer exists or has no name, it was likely removed (success)
        return !field;
      });
      if (wasCleared) {
        return {
          filledFields,
          submitSelector,
          result: 'success',
          resultMessage: 'Form fields cleared after submission',
        };
      }
    } catch { /* non-fatal */ }
  }

  return {
    filledFields,
    submitSelector,
    result: 'unknown',
  };
}

async function detectFormMessages(
  tabId: number
): Promise<{ hasError: boolean; hasSuccess: boolean; message?: string; selectors?: string[] }> {
  try {
    const response = await sendToContentScript<{
      payload: { hasError: boolean; hasSuccess: boolean; message?: string; selectors?: string[] };
    }>(tabId, { type: 'DETECT_FORM_MESSAGES' });
    return response?.payload ?? { hasError: false, hasSuccess: false };
  } catch {
    return { hasError: false, hasSuccess: false };
  }
}

export function generateTestValue(field: FormField): string | undefined {
  switch (field.type) {
    case 'email':
      return 'test@example.com';
    case 'tel':
      return '+1234567890';
    case 'url':
      return 'https://example.com';
    case 'number':
      return field.min ?? '1';
    case 'date':
      return '2025-01-15';
    case 'datetime-local':
      return '2025-01-15T10:30';
    case 'time':
      return '10:30';
    case 'color':
      return '#ff0000';
    case 'range':
      return field.min ?? '50';
    case 'text':
    case 'search':
      // Use field context to generate more realistic values
      if (field.name?.toLowerCase().includes('name') || field.label?.toLowerCase().includes('name')) return 'Test User';
      if (field.name?.toLowerCase().includes('title') || field.label?.toLowerCase().includes('title')) return 'Test Title';
      if (field.name?.toLowerCase().includes('company') || field.label?.toLowerCase().includes('company')) return 'Test Corp';
      if (field.name?.toLowerCase().includes('address') || field.label?.toLowerCase().includes('address')) return '123 Test Street';
      if (field.name?.toLowerCase().includes('city') || field.label?.toLowerCase().includes('city')) return 'Test City';
      if (field.name?.toLowerCase().includes('zip') || field.label?.toLowerCase().includes('zip')) return '12345';
      return 'Test input';
    case 'password':
      return 'TestPassword123!';
    case 'textarea':
      return 'Test description text for automated exploration.';
    case 'select':
      // Pick the first non-empty option
      return field.options?.[0];
    case 'checkbox':
    case 'radio':
      return 'true'; // signal to check/select
    default:
      return 'test';
  }
}

/**
 * Dismiss a modal using multiple strategies (Escape key, then backdrop click).
 * Non-fatal — silently catches errors.
 */
async function dismissModalSafe(tabId: number): Promise<void> {
  // Strategy 1: Press Escape
  try {
    await executeStepViaPort({ order: 0, action: 'press_key', key: 'Escape', description: 'Close modal' }, tabId);
    await delay(400);
  } catch { /* non-fatal */ }

  // Strategy 2: If modal is still there, try clicking a close button or backdrop
  try {
    const stillOpen = await detectModal(tabId);
    if (stillOpen.found) {
      // Try clicking a common close button selector
      const closeSelectors = [
        'button[aria-label*="close" i]',
        'button[aria-label*="Close"]',
        '.close-button',
        '.btn-close',
        '[data-dismiss="modal"]',
        '.modal-close',
        'button.close',
      ];
      for (const sel of closeSelectors) {
        try {
          await executeStepViaPort({ order: 0, action: 'click', selector: sel, description: 'Close modal via button', timeout: 1000 }, tabId);
          await delay(300);
          break;
        } catch {
          // Try next selector
        }
      }
    }
  } catch { /* non-fatal */ }
}

/**
 * Run an async function with a timeout. Rejects if the function doesn't
 * complete within the specified time.
 */
function withTimeout<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Exploration click timeout after ${ms}ms`)), ms);
    fn().then(
      (result) => { clearTimeout(timer); resolve(result); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

async function navigateToUrl(tabId: number, url: string): Promise<void> {
  return new Promise((resolve) => {
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') done();
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url }).catch(() => done());
    setTimeout(done, 10_000);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract API endpoint summaries from HAR entries, filtering out static assets,
 * browser-internal requests, and deduplicating by method+path.
 */
function extractAPIEndpoints(
  entries: HAREntry[],
  context: ObservedAPI['context']
): ObservedAPI[] {
  const seen = new Set<string>();
  const apis: ObservedAPI[] = [];

  // Static asset extensions and patterns to skip
  const SKIP_PATTERNS = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map|webp|avif)(\?|$)/i;
  const SKIP_PREFIXES = ['chrome-extension://', 'data:', 'blob:'];

  for (const entry of entries) {
    if (SKIP_PATTERNS.test(entry.url)) continue;
    if (SKIP_PREFIXES.some((p) => entry.url.startsWith(p))) continue;
    // Skip HTML document loads — we want API calls only
    if (entry.mimeType?.includes('text/html') && entry.method === 'GET') continue;

    // Normalize: remove query params for deduplication
    let endpoint: string;
    try {
      const parsed = new URL(entry.url);
      endpoint = parsed.origin + parsed.pathname;
    } catch {
      endpoint = entry.url;
    }

    const dedup = `${entry.method}:${endpoint}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);

    apis.push({
      endpoint,
      method: entry.method,
      status: entry.status,
      requestContentType: entry.requestHeaders?.['content-type'] ?? entry.requestHeaders?.['Content-Type'],
      responseContentType: entry.mimeType || undefined,
      context,
    });
  }

  return apis.slice(0, 30); // Cap per page to prevent bloat
}
