import { scanPage, scanFormFields, scanPageLinks, scanPageMetadata, scanUnscannedFrames, revealPageContent, getPageSnapshot, partitionExplorationTargets,
  unionWithRevealCandidates, type TargetPartition, detectModal, scanPageActions, scanDataTables, scanPageType, scanWizardSteps, scanConditionalFields } from './page-scanner';
import {
  createGraph,
  addNode,
  addEdge,
  saveGraph,
  saveGraphIncremental,
  saveGraphSnapshot,
  loadGraph,
  removeNode,
  pruneStaleNodes,
} from './interaction-graph';
import type { InteractionGraph, InteractiveElement, FormField, ModalDiscovery, ExplorationProgress, ExplorationCoverage } from '../../storage/schemas';
import type { AIClientInterface } from '../ai/ai-client';
import { getAgentActions } from './action-ranker';
import { probeSelectionActions } from './selection-explorer';
import { classifyControl, isSafeToClick, isSessionEndingUrl } from './danger-heuristics';
import { detectSPARoutes } from './spa-detector';
import { getActiveTabId } from '../../messaging/messenger';
import { executeStep as executeStepViaPort, evaluateInTab } from '../step-executor';
import { createMutationLedger } from '../safety/mutation-ledger';
import { describePolicy, isPolicyEmpty, resolvePolicy } from '../safety/policy-resolver';
import { installRunSafety, type SafetyHandle } from '../safety/safety-port';
import { attach, detach, isAttached, startHARCapture, getHAREntries, captureFullPageScreenshot } from '../cdp/cdp-client';
import { ensureAuthenticated } from '../executor/auth-manager';
import { runAccessibilityAudit } from '../analysis/accessibility-audit';
import type { A11yAuditResult } from '../analysis/accessibility-audit';
import { computeRiskCoverage, formatRiskCoverage } from './risk-coverage';
import { createCheckpoint, describeResume, evaluateCheckpoint, hashOptions, type ExplorationCheckpoint } from './exploration-checkpoint';
import { clearCheckpoint, loadCheckpoint, persistCheckpoint } from '../../storage/checkpoint-storage';
import {
  EXHAUSTIVE_TARGET_CAP,
  adaptBudget,
  budgetForPage,
  delay,
  settle,
  withTimeout,
} from './exploration-primitives';
import { captureFormOutcome, exploreFormSubmission, findSubmitButton } from './form-explorer';
import { extractAPIEndpoints } from './observed-apis';
import { createLogger } from '../../utils/logger';

// Re-exported so existing importers and tests keep working unchanged: the file
// boundary moved, the public surface did not.
export { findSubmitButton, generateTestValue } from './form-explorer';

// Re-exported so existing importers and tests keep working unchanged: the file
// boundary moved, the public surface did not.
export { adaptBudget, budgetCeiling, budgetForPage } from './exploration-primitives';

const log = createLogger('explorer');

/**
 * Resolve the best human-readable label for a clicked element.
 * Prefers: short visible text > aria-label > AI description > selector.
 * Strips long textContent down to the first meaningful phrase.
 */
/**
 * Union two element inventories by selector, preferring `primary`.
 *
 * `primary` is the settled post-sweep scan; `extra` is what the sweep saw while
 * scrolling. Elements only in `extra` are virtualized or lazy content that is no
 * longer mounted — real targets, but ones a click must scroll back into view.
 */
function mergeElements(
  primary: InteractiveElement[],
  extra: InteractiveElement[]
): InteractiveElement[] {
  const bySelector = new Map<string, InteractiveElement>();
  for (const el of primary) bySelector.set(el.selector, el);
  for (const el of extra) if (!bySelector.has(el.selector)) bySelector.set(el.selector, el);
  return [...bySelector.values()];
}

/**
 * Read the tab's URL, cheaply.
 *
 * This used to go through `getPageSnapshot`, which serialises a compressed DOM and
 * re-scans every interactive element — after EVERY click, purely to learn whether
 * the URL changed. On a heavy SPA that single call dominated the cost of a click:
 * a measured run averaged 11.7s per target against a 2s estimate, and only 41 of
 * 54 targets fit in the page budget.
 *
 * Falls back to the snapshot when no evaluator is registered, so the behaviour is
 * unchanged where the port is not wired.
 */
async function readCurrentUrl(tabId: number, fallbackUrl: string): Promise<string> {
  try {
    const url = await evaluateInTab<string>(tabId, 'location.href');
    if (typeof url === 'string' && url.length > 0) return url;
  } catch {
    // No evaluator registered, or the frame was mid-navigation.
  }
  const snap = await getPageSnapshot(tabId).catch(() => null);
  return snap?.url ?? fallbackUrl;
}

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
/**
 * Whether a page can skip its interaction pass because nothing about it changed.
 *
 * This applies to FRESH runs only, and that is not a mistake: an incremental run
 * pre-seeds `visitedUrls` with every known URL, so a previously-mapped page is
 * never re-scanned there and has no fingerprint to compare. Fresh is the only
 * mode that revisits a known page, so it is the only mode where the saving
 * exists.
 *
 * The start page is always exempt. It is the page the user explicitly aimed the
 * run at, and a screen whose structure never varies between runs — a login
 * form, most obviously — otherwise matched its stored fingerprint on every run
 * and was skipped without a single click, which reads as "explore does nothing".
 * A skipped interior page costs coverage; a skipped start page costs the whole
 * run.
 */
/**
 * What survived a navigation away from the page and back.
 *
 * The link-derived in-page views are opened by navigating: away to the view's
 * URL, then back to the page. Everything after that point in the pass — the
 * click targets, the form interaction, the modal probes — was selected from a
 * scan taken BEFORE that excursion, and an SPA that remounts its tree on return
 * can invalidate those selectors wholesale. The mocked tests cannot see this:
 * their fake page returns the same markup no matter what navigations happen.
 *
 * So rather than assume the return is lossless, the page is re-scanned and the
 * two scans compared. `lost` is what the pass would have gone on clicking at
 * selectors that no longer resolve.
 *
 * Pure and exported so the comparison is tested directly, independent of any
 * page model that would beg the question.
 */
export function reconcileAfterExcursion(args: {
  before: InteractiveElement[];
  after: InteractiveElement[];
}): { elements: InteractiveElement[]; lost: string[]; changed: boolean } {
  const afterSelectors = new Set(args.after.map((e) => e.selector));
  const lost = args.before.map((e) => e.selector).filter((sel) => !afterSelectors.has(sel));

  // An empty re-scan means the scan failed or the page had not finished
  // remounting — not that the page is genuinely empty. Keeping the pre-excursion
  // view is the better of two imperfect options: it may be stale, whereas
  // nothing is certainly useless.
  if (args.after.length === 0) {
    return { elements: args.before, lost: [], changed: false };
  }

  return { elements: args.after, lost, changed: lost.length > 0 || args.after.length !== args.before.length };
}

export function shouldSkipUnchanged(args: {
  fresh: boolean;
  reexplorePage: boolean;
  isStartPage: boolean;
  priorStructureHash: string | undefined;
  structureHash: string;
  /** Whether the stored node's interaction pass actually finished. */
  priorInteractionComplete: boolean | undefined;
}): boolean {
  if (!args.fresh) return false;
  // Re-explore wipes the node first, so there is normally no prior hash to
  // match; refusing explicitly keeps that from depending on deletion order.
  if (args.reexplorePage || args.isStartPage) return false;
  // The fingerprint comes from the pre-click scan, so it cannot tell a page
  // whose buttons were all explored from one whose interaction pass never ran.
  // Requiring a completed pass is what stops an unfinished page from looking
  // settled forever.
  if (!args.priorInteractionComplete) return false;
  return !!args.priorStructureHash && args.priorStructureHash === args.structureHash;
}

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
/**
 * Most link-derived in-page views visited per page.
 *
 * Each one costs a navigation, a settle, a scan, and a re-scan of the page on
 * return, so this is a real budget item rather than a formality. Five covers the
 * tab strips seen in practice without letting a page of anchor links consume the
 * whole page budget.
 *
 * This is the DEFAULT, overridable per run via `maxLinkTabsPerPage`. It stays at
 * five because the per-visit cost has not been measured against a real tabbed
 * application — raising it on a guess would swap a shortfall that is reported
 * for a budget overrun that is not.
 */
export const MAX_LINK_TABS_SCANNED = 5;

/**
 * What is inside an in-page view, read while it is open.
 *
 * Best-effort by design: a tab that fails to scan should still be recorded as
 * existing, because a label and a URL is strictly better than nothing.
 */
async function captureTabContents(
  tabId: number
): Promise<{ formFields?: FormField[]; elementCount?: number; headings?: string[] }> {
  try {
    const [fields, els, meta] = await Promise.all([
      scanFormFields(tabId).catch(() => [] as FormField[]),
      scanPage(tabId).catch(() => [] as InteractiveElement[]),
      scanPageMetadata(tabId).catch(() => ({ headings: [] as string[] })),
    ]);
    return {
      formFields: fields.length > 0 ? fields : undefined,
      elementCount: els.length > 0 ? els.length : undefined,
      headings: meta.headings.length > 0 ? meta.headings.slice(0, 6) : undefined,
    };
  } catch {
    return {};
  }
}

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



/** Default number of pages explored in parallel (bounded tab-worker pool). */
const DEFAULT_EXPLORE_CONCURRENCY = 3;
/** Hard cap on parallel exploration tabs — mirrors the executor's 1-4 range. */
const MAX_EXPLORE_CONCURRENCY = 4;



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
  /**
   * How many link-derived in-page views to open per page.
   *
   * Defaults to `MAX_LINK_TABS_SCANNED`. Configurable rather than raised: each
   * view costs a navigation, a settle, a scan and — since the excursion can
   * remount an SPA — a re-scan of the page on return, and nobody has yet
   * measured that cost against a real tabbed application. Raising the default
   * on an unmeasured guess would trade a stated shortfall for an unstated
   * budget overrun. Anything past the cap is still recorded and warned about.
   */
  maxLinkTabsPerPage?: number;
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
    // No default: an unset budget is derived per page from its target count
    // (budgetForPage), which a single flat number cannot do correctly.
    pageBudgetMs,
    runBudgetMs,
    captureScreenshots = false,
    exhaustiveStartPage = false,
    maxLinkTabsPerPage = MAX_LINK_TABS_SCANNED,
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

  const graph = (await loadGraph()) ?? createGraph();
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
  const safetyHandles: SafetyHandle[] = [];
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

  // ── Resume an interrupted run ────────────────────────────────────────────
  // The whole point of writing checkpoints (§4). Without this read, the crawl
  // persisted its frontier on every page and then restarted from the seed anyway
  // — the cost of durability with none of the benefit.
  //
  // Skipped for fresh/re-explore runs: those mean "ignore what we knew", so
  // resuming would contradict the request.
  const optionsHash = hashOptions({ maxDepth, maxPages, submitForms, agentMode });
  const runId = `explore-${runStart}`;
  let resumedFrom: ExplorationCheckpoint | null = null;
  if (!fresh && !reexplorePage) {
    const decision = evaluateCheckpoint(await loadCheckpoint(), {
      startUrl,
      optionsHash,
      now: runStart,
    });
    // Both outcomes are stated. A silent refusal would present a full restart as
    // a resume, and the user would watch pages be re-walked with no explanation.
    log.info(describeResume(decision));
    if (decision.resume) {
      resumedFrom = decision.checkpoint;
      for (const url of decision.checkpoint.visited) visitedUrls.add(url);
      // Restore the frontier in its stored order, ahead of the seed. Each entry
      // goes through tryEnqueue's bookkeeping so pattern slots stay reserved
      // exactly once.
      queue.length = 0;
      queuedUrls.clear();
      for (const entry of decision.checkpoint.frontier) {
        if (visitedUrls.has(entry.url) || queuedUrls.has(entry.url)) continue;
        queue.push({ url: entry.url, depth: entry.depth });
        queuedUrls.add(entry.url);
      }
      // The seed goes back only if the checkpoint did not already cover it —
      // otherwise a resumed run re-scans the page it was already past.
      if (!visitedUrls.has(startUrl) && !queuedUrls.has(startUrl)) {
        queue.push({ url: startUrl, depth: 0 });
        queuedUrls.add(startUrl);
      }
      addWarning(
        `Resumed from a checkpoint: ${decision.checkpoint.visited.length} page(s) already mapped, ` +
          `${queue.length} queued. Pass fresh=true to ignore it and re-walk everything.`
      );
    }
  }
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
    // Keeps what the sweep saw: virtualized rows mounted mid-scroll are gone by
    // the time the scan below runs, so without this they were never discovered.
    const revealedElements = await revealPageContent(tabId);

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
    const [scannedElements, formFields, hrefLinks, pageMetadata, pageActions, dataTables, pageTypeInfo, wizardSteps, conditionalFields, unscannedFrames] = await Promise.all([
      scanPage(tabId),
      scanFormFields(tabId),
      startOrigin ? scanPageLinks(tabId, startOrigin) : Promise.resolve([] as Array<{ url: string; text: string }>),
      scanPageMetadata(tabId),
      scanPageActions(tabId),
      scanDataTables(tabId),
      scanPageType(tabId),
      scanWizardSteps(tabId),
      scanConditionalFields(tabId),
      scanUnscannedFrames(tabId),
    ]);

    // Union of the settled scan and the sweep. Deduped by selector, with the
    // settled sighting winning: its geometry describes the page as a user finds
    // it, while a mid-scroll sighting describes a transient position.
    // Reassigned after the in-page-view excursion below, which navigates away
    // from this page and back.
    let elements = mergeElements(scannedElements, revealedElements);
    if (elements.length > scannedElements.length) {
      log.info(
        `Reveal sweep contributed ${elements.length - scannedElements.length} element(s) ` +
          `not present in the settled scan (virtualized/lazy content)`
      );
    }

    // ── 3a. Broken/error page — record as a broken link, don't map it ──
    if (pageTypeInfo.isErrorPage) {
      brokenLinkUrls.add(currentUrl);
      addWarning(`Broken/error page (${pageTypeInfo.httpStatus ?? 'unknown status'}): ${currentUrl}`);
      return;
    }

    coverage.pagesScanned++;

    const priorNode = graph.nodes.find((n) => n.url === currentUrl);
    const priorStructureHash = priorNode?.structureHash;
    const priorInteractionComplete = priorNode?.interactionComplete;
    // Fingerprint from the SETTLED scan, not the union. Which virtualized rows
    // happen to mount during a sweep varies run to run, so hashing the union
    // would make the fingerprint differ every time and permanently disable the
    // skip-unchanged fast path.
    const structureHash = computeStructureFingerprint(scannedElements, formFields);
    const structureUnchanged = shouldSkipUnchanged({
      fresh,
      reexplorePage,
      isStartPage: depth === 0,
      priorStructureHash,
      structureHash,
      priorInteractionComplete,
    });

    const node = addNode(graph, currentUrl, currentTitle, elements.length, formFields);
    node.structureHash = structureHash;
    // Cleared for this run and set again only if the pass below finishes, so an
    // interrupted run cannot leave a stale "complete" behind.
    node.interactionComplete = undefined;
    seenThisRun.add(currentUrl);

    if (pageMetadata.breadcrumb) node.breadcrumb = pageMetadata.breadcrumb;
    if (pageMetadata.headings.length > 0) node.headings = pageMetadata.headings;
    node.pageType = pageTypeInfo.pageType;
    node.isErrorPage = pageTypeInfo.isErrorPage || undefined;
    node.httpStatus = pageTypeInfo.httpStatus;
    if (pageActions.length > 0) node.actions = pageActions;
    // Recorded even though nothing can be done about it: a page whose sign-in
    // or payment step lives in a third-party iframe must not be reported as
    // fully mapped. Same-origin frames never appear here — those are walked as
    // part of the page.
    if (unscannedFrames.length > 0) {
      node.unscannedFrames = unscannedFrames;
      addWarning(
        `${unscannedFrames.length} cross-origin frame(s) on ${currentUrl} could not be scanned` +
          ` (${unscannedFrames.map((f) => f.label ?? f.origin ?? 'unlabelled').join(', ')})` +
          ` — their contents are not covered.`
      );
    }
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

    /** State the coverage cost of every safety decision, per page. */
    function reportWithheld(url: string, p: TargetPartition): void {
      if (p.sessionEnding.length > 0) {
        log.info(
          `Withheld ${p.sessionEnding.length} session-ending control(s) on ${url} ` +
            `(${p.sessionEnding.slice(0, 3).map((el) => classifyControl(el).risk === 'session-ending'
              ? (classifyControl(el) as { reason: string }).reason
              : resolveElementLabel(el)).join('; ')}). ` +
            `These are never clicked — a logged-out crawler maps the login page.`
        );
      }
      if (p.destructive.length > 0) {
        const how = p.destructive
          .slice(0, 3)
          .map((el) => {
            const v = classifyControl(el);
            return v.risk === 'destructive' ? v.reason : resolveElementLabel(el);
          })
          .join('; ');
        log.info(
          `Withheld ${p.destructive.length} destructive control(s) on ${url} (${how}` +
            `${p.destructive.length > 3 ? ', …' : ''}). Set includeDangerous to explore them.`
        );
      }
      if (p.unidentified.length > 0) {
        addWarning(
          `${p.unidentified.length} unnamed control(s) in data rows on ${url} were NOT clicked — ` +
            `no label, no title and no recognisable icon, so their effect is unknown. ` +
            `These are commonly row-level edit/delete actions; the app should give them ` +
            `accessible names for them to be testable.`
        );
      }
      if (p.overCap > 0) {
        addWarning(`${p.overCap} click target(s) on ${url} exceeded the per-page cap and were not tried.`);
      }
      if (p.rowNavigationsSkipped > 0) {
        // Sampling rows is a deliberate choice, so it is stated as one. Rows lead
        // to the same detail template, so a sample discovers it; the count makes
        // clear this is not per-record coverage.
        log.info(
          `Sampled row navigations on ${url}: clicked up to 3, skipped ${p.rowNavigationsSkipped} ` +
            `further row(s) leading to the same detail template.`
        );
      }
    }

    emitProgress(currentTitle || currentUrl, 'running');

    // ── 4. Enqueue discovered href links (depth-independent) ─────────────
    // In-page links are collected first and visited after the loop: opening one
    // mid-loop would navigate the tab out from under the remaining links.
    const linkTabs: Array<{ label: string; url: string }> = [];
    for (const link of hrefLinks) {
      // Never walk into a logout URL. Links are enqueued without being clicked, so
      // the click-set classifier never sees them — this is the only place a
      // `/logout` href can be stopped before it becomes a navigation.
      if (isSessionEndingUrl(link.url)) {
        log.info(`Skipping session-ending link: ${link.url}`);
        continue;
      }
      const change = classifyUrlChange(currentUrl, link.url);
      if (change === 'in-page') {
        if (!linkTabs.some((t) => t.url === link.url)) {
          linkTabs.push({ label: link.text || link.url, url: link.url });
        }
        continue;
      }
      if (change === 'navigation' && !visitedUrls.has(link.url)) {
        addEdge(graph, currentUrl, link.url, 'link', 'a[href]', link.text);
        if (depth < maxDepth) tryEnqueue(link.url, depth + 1);
      }
    }

    // ── 4b. Open each in-page view and read what is inside it ────────────────
    // These are never enqueued as pages — same path, so the BFS treats them as
    // already visited. Opening them here is the only way their forms are ever
    // seen; without it a tabbed page yields labels and nothing else.
    if (linkTabs.length > 0) {
      if (!node.tabs) node.tabs = [];
      const unscanned = linkTabs.filter((t) => !node.tabs!.some((existing) => existing.url === t.url));
      for (const tab of unscanned.slice(0, maxLinkTabsPerPage)) {
        try {
          await navigateToUrl(tabId, tab.url);
          await settle(tabId);
          const contents = await captureTabContents(tabId);
          node.tabs.push({ ...tab, ...contents });
        } catch (err) {
          // Record it anyway: a label and a URL beats losing the view entirely.
          node.tabs.push(tab);
          log.debug(`Could not open in-page view ${tab.url}`, err);
        }
      }
      // Anything past the cap is still recorded, just not opened — stating the
      // shortfall rather than silently capping (§13).
      const skipped = unscanned.slice(maxLinkTabsPerPage);
      for (const tab of skipped) node.tabs.push(tab);
      if (skipped.length > 0) {
        addWarning(
          `${skipped.length} in-page view(s) on ${currentUrl} were recorded but not opened ` +
            `(cap ${maxLinkTabsPerPage} per page) — their contents are unknown.`
        );
      }
      // Back to the page the rest of this pass assumes we are on — and then
      // re-scan it, because "back" is not automatically "as it was". Everything
      // below picks targets from `elements`, and an SPA that remounts on return
      // leaves those selectors pointing at nodes that no longer exist.
      if (unscanned.length > 0) {
        await navigateToUrl(tabId, currentUrl);
        await settle(tabId);
        const rescanned = await scanPage(tabId).catch(() => [] as InteractiveElement[]);
        const reconciled = reconcileAfterExcursion({ before: elements, after: rescanned });
        if (reconciled.changed) {
          log.info(
            `Re-scan after opening ${unscanned.length} in-page view(s) on ${currentUrl}: ` +
              `${reconciled.lost.length} element(s) no longer resolve; using the fresh scan.`
          );
        }
        elements = reconciled.elements;
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
    const partition = partitionExplorationTargets(elements, getVisitedForPage(currentUrl), {
      includeDangerous,
      maxTargets: exhaustiveThisPage ? EXHAUSTIVE_TARGET_CAP : undefined,
    });
    // Say what was withheld. Skipping 50 delete buttons and reporting nothing
    // looks identical to a page that had none (§13, no silent caps).
    reportWithheld(currentUrl, partition);

    if (exhaustiveThisPage) {
      targets = partition.targets;
      log.info(`Exhaustive mode: clicking all ${targets.length} interactive elements on "${currentTitle || currentUrl}"`);
    } else if (useAgentMode) {
      const agentActions = await getAgentActions(currentUrl, currentTitle, elements, visitedUrls, getVisitedForPage(currentUrl), aiClient!);
      if (agentActions.length === 0) {
        log.info(`Agent mode: no high-value actions on "${currentTitle || currentUrl}" — using standard fallback`);
        targets = partition.targets;
      } else {
        // The ranker sees every element, so filter its picks through the same
        // safety gate the deterministic path uses — a model suggesting "click the
        // trash icon" must not bypass what the classifier just withheld.
        // Session-ending selectors are excluded unconditionally; the rest respect
        // includeDangerous. A model suggesting "click Sign out" must not be able to
        // end the run just because destructive exploration was enabled.
        const neverClick = new Set(partition.sessionEnding.map((e) => e.selector));
        const withheld = new Set([...partition.destructive, ...partition.unidentified].map((e) => e.selector));
        const allowed = agentActions.filter(
          (a) => !neverClick.has(a.selector) && (includeDangerous || !withheld.has(a.selector))
        );
        if (allowed.length < agentActions.length) {
          log.warn(
            `Agent mode: dropped ${agentActions.length - allowed.length} AI-ranked action(s) on ` +
              `${currentUrl} that the safety classifier withheld.`
          );
        }
        const ranked = allowed.map((a) => {
          const matchedEl = elements.find((el) => el.selector === a.selector);
          return { selector: a.selector, text: matchedEl?.text || undefined, ariaLabel: matchedEl?.ariaLabel || undefined, description: a.description };
        });

        // The model's picks REPLACED the deterministic list, so a `<button>` it
        // did not happen to rank was never clicked — and a form that exists
        // only after that click was therefore never captured. Deciding which
        // elements are interesting is a fair cost control; deciding which
        // elements exist is not. The union is bounded so agent mode keeps its
        // cost advantage, and drawn from the already-gated partition so the
        // safety classifier's refusals are inherited rather than re-litigated.
        const union = unionWithRevealCandidates(
          ranked,
          partition.targets,
          (t) => t.selector,
          (el) => ({
            selector: el.selector,
            text: el.text || undefined,
            ariaLabel: el.ariaLabel || undefined,
            description: `Reveal candidate: ${resolveElementLabel(el)}`,
          })
        );
        targets = union.targets;

        log.info(
          `Agent mode: clicking ${ranked.length} AI-ranked element(s) on ` +
            `"${currentTitle || currentUrl}"` +
            (union.added > 0
              ? `, plus ${union.added} stay-on-page control(s) the ranker omitted`
              : '')
        );
        if (union.omitted > 0) {
          // §13: a cap that drops candidates says so. Without this, a page with
          // many buttons looks fully explored when it was not.
          addWarning(
            `${union.omitted} stay-on-page control(s) on ${currentUrl} were neither ` +
              `AI-ranked nor within the reveal-candidate cap — a form behind one of ` +
              `them would not be captured.`
          );
        }
      }
    } else {
      targets = partition.targets;
    }

    const pageExplorationStart = Date.now();
    // Sized to the work in front of it (see budgetForPage). An explicit
    // pageBudgetMs still wins — a caller who names a number means it.
    // Starts from the estimate and grows toward the ceiling as real click costs
    // come in. An explicit pageBudgetMs is taken literally and never adapted — a
    // caller who names a number means it.
    let effectivePageBudget = pageBudgetMs ?? budgetForPage(targets.length, exhaustiveThisPage);
    log.info(
      `Page budget for "${currentTitle || currentUrl}": ${Math.round(effectivePageBudget / 1000)}s ` +
        `for ${targets.length} target(s)${exhaustiveThisPage ? ' (exhaustive)' : ''}`
    );
    // Selectors known before each click — used to detect elements REVEALED by a
    // click (dropdown menus, expanded panels) so we can click those too.
    const knownSelectors = new Set(elements.map((e) => e.selector));
    // Form fields are scanned once, before any click. Anything appearing after
    // a click is new by definition, and used to be discarded.
    const knownFieldSelectors = new Set(formFields.map((f) => f.selector));
    let revealedCount = 0;

    // A pass that ends early must not be recorded as complete, or the page is
    // skipped on every later run with its remaining targets never tried.
    let interactionTruncated = false;
    for (let ti = 0; ti < targets.length; ti++) {
      const target = targets[ti];
      if (signal?.aborted) {
        interactionTruncated = true;
        break;
      }
      const elapsedOnPage = Date.now() - pageExplorationStart;
      if (elapsedOnPage > effectivePageBudget) {
        // A warning, not an info line: truncated exploration reads as full
        // coverage in the report unless the shortfall is stated (§13, no silent caps).
        // The measured rate is included because it is the actionable part — it says
        // whether the page is slow or the budget is simply too small.
        const perTarget = ti > 0 ? Math.round(elapsedOnPage / ti / 100) / 10 : 0;
        addWarning(
          `Page budget (${Math.round(effectivePageBudget / 1000)}s, the ceiling for this mode) ` +
            `exhausted on ${currentUrl} — explored ${ti} of ${targets.length} target(s) at ` +
            `~${perTarget}s each; ${targets.length - ti} not tried.`
        );
        interactionTruncated = true;
        break;
      }
      if (pageBudgetMs === undefined) {
        effectivePageBudget = adaptBudget(
          effectivePageBudget, elapsedOnPage, ti, targets.length, exhaustiveThisPage
        );
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

          const afterUrl = await readCurrentUrl(tabId, currentUrl);
          const change = classifyUrlChange(beforeUrl, afterUrl);

          if (change === 'in-page') {
            stayedOnPage = false;
            const label = resolveElementLabel(target);
            if (!node.tabs) node.tabs = [];
            if (!node.tabs.some((t) => t.url === afterUrl)) {
              // Scan BEFORE navigating back. The view is already open, so this
              // costs nothing extra — and it is the only moment its contents
              // are reachable.
              const contents = await captureTabContents(tabId);
              node.tabs.push({ label, url: afterUrl, ...contents });
              log.info(
                `In-page view discovered via "${label}" on ${currentUrl}` +
                  (contents.formFields?.length
                    ? ` — ${contents.formFields.length} form field(s) captured inside it`
                    : '')
              );
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
            // Same classifier as the main pass. This filter used to read text
            // only, which meant a menu that revealed an icon-only "Delete"
            // queued it for clicking.
            // isSafeToClick, not a raw classify: it refuses session-ending
            // controls even when includeDangerous is set, and a user menu revealed
            // by a click is exactly where "Sign out" lives.
            if (!isSafeToClick(el, includeDangerous)) continue;
            targets.push({ selector: el.selector, text: el.text || undefined, ariaLabel: el.ariaLabel || undefined });
            revealedCount++;
            added++;
          }
          // ── Revealed form fields ──────────────────────────────────────
          // A click that swaps a form into the page fires none of the branches
          // above: the URL is unchanged and no dialog opens. Without this the
          // fields are never recorded, and generation invents them.
          const afterFields = await scanFormFields(tabId).catch(() => [] as FormField[]);
          const newFields = afterFields.filter((f) => !knownFieldSelectors.has(f.selector));
          if (newFields.length > 0) {
            for (const f of newFields) knownFieldSelectors.add(f.selector);
            const triggerLabel = resolveElementLabel(target);
            if (!node.revealedForms) node.revealedForms = [];
            if (!node.revealedForms.some((r) => r.triggerSelector === target.selector)) {
              node.revealedForms.push({
                triggerSelector: target.selector,
                triggerLabel,
                formFields: newFields,
              });
              log.info(
                `Revealed ${newFields.length} form field(s) via "${triggerLabel}" on ${currentUrl} — ` +
                  `recorded with its trigger`
              );
            }
          }

          if (added > 0) {
            log.info(`Revealed ${added} new element(s) via "${resolveElementLabel(target)}" — queued for exploration`);
          }
          // Only dismiss when nothing was revealed in place: pressing Escape
          // after a form appears can collapse the very thing just captured, and
          // the revealed controls still need to be clickable on the next pass.
          if (added > 0 && newFields.length === 0) {
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

    // Every target was tried, so the fingerprint stored above now genuinely
    // describes a finished page and a later run may trust it.
    if (!interactionTruncated) node.interactionComplete = true;

    // ── 5b. Selection discovery: what does checking a row reveal? ─────────────
    // Row checkboxes are safe by default (client-side selection only). Settings
    // toggles usually persist on change, so they ride the existing mutation gate.
    try {
      const selectionDiscoveries = await probeSelectionActions(
        elements,
        getVisitedForPage(currentUrl),
        {
          click: async (selector, description) => {
            await executeStepViaPort({ order: 0, action: 'click', selector, description }, tabId);
          },
          scanActions: () => scanPageActions(tabId),
          settle: () => settle(tabId, { idleMs: 350 }),
        },
        {
          includeSettingsToggles: submitForms,
          maxTargets: exhaustiveThisPage ? 8 : 3,
        }
      );
      if (selectionDiscoveries.length > 0) {
        node.selectionActions = selectionDiscoveries;
        for (const d of selectionDiscoveries) {
          if (!d.resetOk) {
            addWarning(
              `Selection via "${d.triggerLabel}" on ${currentUrl} could not be undone — ` +
                `later findings on this page may reflect an active selection.`
            );
          }
        }
      }
    } catch (err) {
      addWarning(
        `Selection exploration failed on ${currentUrl}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // ── 6. Form interaction discovery (mutates app — gated behind submitForms) ──
    if (submitForms && formFields.length > 0 && depth <= maxDepth) {
      try {
        await exploreFormSubmission(tabId, currentUrl, formFields, elements, graph, navigateToUrl);
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

  /**
   * Persist the frontier so an interrupted run can resume.
   *
   * The graph was already saved incrementally, so data was never lost — but the
   * frontier and visited set lived only in these closures, so an evicted worker
   * restarted from the seed and re-walked everything. Written on dequeue: at most
   * one page of progress is lost, which is the honest guarantee (§4).
   */
  const saveCheckpoint = (): void => {
    void persistCheckpoint(
      createCheckpoint({
        runId,
        startUrl,
        optionsHash,
        frontier: queue,
        visited: visitedUrls,
        pagesScanned: coverage.pagesScanned,
        now: Date.now(),
      })
    ).catch((err) => log.debug('Checkpoint save failed (non-fatal)', err));
  };

  const dequeueNext = (): { url: string; depth: number } | null => {
    while (queue.length > 0) {
      if (visitedUrls.size >= maxPages) return null;
      const entry = queue.shift()!;
      if (visitedUrls.has(entry.url)) continue;
      visitedUrls.add(entry.url);
      coverage.pagesAttempted++;
      saveCheckpoint();
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
  // Report page-breaking refusals as a run-level warning, not a log line. A
  // policy that aborted the app's own scripts means the crawl mapped a shell that
  // never booted — a result that LOOKS valid, which is why it has to be said out
  // loud in the report the user reads.
  for (const handle of safetyHandles) {
    for (const blocked of handle.criticalBlocks()) {
      addWarning(
        `Request enforcement blocked a resource the page needs: ${blocked}. ` +
          `The app may not have loaded — add this origin to the project allowlist and re-run.`
      );
    }
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

  // A completed run has nothing to resume — leaving the checkpoint would offer a
  // stale resume on the next exploration.
  await clearCheckpoint().catch(() => undefined);

  // ── Finalise coverage ─────────────────────────────────────────────────────
  coverage.untestedPaths = countUntestedPaths();
  coverage.brokenLinks = brokenLinkUrls.size;
  coverage.coverageRatio = computeCoverageRatio();

  // Risk-weighted coverage alongside the legacy ratio. The legacy figure is kept
  // for continuity, but it is self-referential — it cannot distinguish "explored
  // the whole app" from "discovered almost nothing and explored that".
  try {
    const visited = new Set(graph.nodes.map((n) => n.url));
    const discoveredNotVisited = [
      ...new Set(graph.edges.map((e) => e.to).filter((u) => !visited.has(u))),
    ];
    const risk = computeRiskCoverage({ graph, discoveredNotVisited });
    coverage.riskCoverageRatio = risk.ratio;
    coverage.highRiskGaps = risk.highRiskGaps;
    log.info(
      `Coverage: ${coverage.pagesScanned} scanned, legacy ratio ${Math.round(coverage.coverageRatio * 100)}%, ` +
        `RISK-weighted ${Math.round(risk.ratio * 100)}% (${risk.highRiskGaps} high-risk page(s) unexplored)`
    );
    if (risk.gaps.length > 0) {
      log.info(formatRiskCoverage(risk));
    }
  } catch (err) {
    // Coverage reporting must never fail a completed exploration.
    log.warn('Risk coverage computation failed', err);
  }
  // Structural limits, tallied from the graph rather than counted during the
  // run: a page re-scanned on a resume would otherwise be counted twice.
  const framePages = graph.nodes.filter((n) => (n.unscannedFrames?.length ?? 0) > 0);
  if (framePages.length > 0) {
    const frames = framePages.reduce((sum, n) => sum + (n.unscannedFrames?.length ?? 0), 0);
    coverage.unsupported = {
      ...coverage.unsupported,
      crossOriginFrames: { frames, pages: framePages.length },
    };
    log.info(
      `Not covered: ${frames} cross-origin frame(s) across ${framePages.length} page(s). ` +
        `Their contents are unreachable — resuming the run will not reach them.`
    );
  }

  coverage.complete = runCompleted;
  if (resumedFrom) {
    // `pagesScanned` counts THIS segment. Reporting it alone after a resume reads
    // as the whole crawl's coverage, which understates the map on disk.
    log.info(
      `This segment scanned ${coverage.pagesScanned} page(s); ` +
        `${resumedFrom.pagesScanned} were already scanned before the interruption ` +
        `(${graph.nodes.length} node(s) in the graph).`
    );
  }
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
 * Dismiss a modal using multiple strategies (Escape key, then backdrop click).
 * Non-fatal — silently catches errors.
 */
/**
 * Navigate a tab and resolve when it reports complete.
 *
 * Stays in this file rather than moving out with the other primitives: it is
 * the one helper that touches `chrome.*`, and `src/core/**` is barred from
 * doing so except for the files already on the burn-down list in
 * `.eslintrc.cjs` — which says, in as many words, never to add to it. Passing
 * it into `form-explorer` keeps the new module clean instead.
 *
 * Resolves rather than rejects on failure, and resolves anyway after ten
 * seconds: exploration must keep moving past a page that never finishes
 * loading, and a rejection here would abort the whole page rather than skip it.
 */
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








