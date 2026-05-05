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
} from './interaction-graph';
import type { InteractionGraph, InteractiveElement, FormField, FormSubmissionOutcome, ModalDiscovery, ExplorationProgress, ObservedAPI } from '../../storage/schemas';
import type { AIClientInterface } from '../ai/ai-client';
import { getAgentActions } from './agent-explorer';
import { detectSPARoutes } from './spa-detector';
import { sendToContentScript, getActiveTabId } from '../../messaging/messenger';
import { attach, detach, isAttached, startHARCapture, getHAREntries } from '../cdp/cdp-client';
import type { HAREntry } from '../cdp/cdp-client';
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

const ACTION_DELAY_MS = 1000;
/** Maximum time to spend on click-exploration per page (ms). */
const PAGE_EXPLORATION_BUDGET_MS = 360_000; // 6 minutes
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
function normalizeUrlPattern(url: string): string {
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
class PatternTracker {
  private counts = new Map<string, number>();

  /** Check if we should explore this URL. Returns the pattern. */
  shouldExplore(url: string): { pattern: string; allowed: boolean } {
    const pattern = normalizeUrlPattern(url);
    const count = this.counts.get(pattern) ?? 0;
    // If the URL IS the pattern (no dynamic segments), always allow
    if (pattern === url) return { pattern, allowed: true };
    return { pattern, allowed: count < MAX_INSTANCES_PER_PATTERN };
  }

  /** Record that a URL with this pattern was visited. */
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
  onProgress?: (progress: ExplorationProgress) => void;
  signal?: AbortSignal;
}

export interface ExploreResult {
  graph: InteractionGraph;
  a11yResults: A11yAuditResult[];
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
    onProgress,
    signal,
  } = options;
  const useAgentMode = agentMode && !!aiClient;

  let graph = (await loadGraph()) ?? createGraph();
  const tabId = await getActiveTabId();
  const a11yResults: A11yAuditResult[] = [];

  // ── Attach CDP for HAR capture during exploration ──────────────────────────
  let cdpAvailable = false;
  try {
    await attach(tabId);
    await startHARCapture(tabId);
    cdpAvailable = true;
    log.info('CDP attached for API endpoint capture during exploration');
  } catch {
    log.info('CDP unavailable — API endpoint capture disabled for this exploration');
  }

  // ── Determine start URL ─────────────────────────────────────────────────────
  let startUrl: string;
  if (explicitStartUrl) {
    startUrl = explicitStartUrl;
    // Navigate to the target page before anything else
    await navigateToUrl(tabId, startUrl);
    await delay(ACTION_DELAY_MS);
  } else {
    const tab = await chrome.tabs.get(tabId);
    startUrl = tab.url ?? '';
  }

  // ── Same-origin guard ───────────────────────────────────────────────────────
  let startOrigin = '';
  try {
    startOrigin = new URL(startUrl).origin;
  } catch {
    // non-standard URL — allow without constraint
  }

  // ── Re-explore: snapshot first, then wipe stale data for this page ──────────
  if (reexplorePage && explicitStartUrl) {
    await saveGraphSnapshot(`before re-explore: ${explicitStartUrl}`);
    removeNode(graph, explicitStartUrl);
    await saveGraph(graph);
    log.info(`Re-exploring page: ${explicitStartUrl}`);
  }

  // ── Seed the BFS queue ──────────────────────────────────────────────────────
  // fresh=true (full re-exploration) or reexplorePage=true (single page) both
  // start with an empty visited set so previously seen URLs are revisited.
  const visitedUrls = new Set<string>(
    fresh || reexplorePage ? [] : graph.nodes.map((n) => n.url)
  );
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

  // ── URL pattern deduplication ──────────────────────────────────────────────
  // Recognizes parameterized routes (e.g. /asset/:id) and caps exploration
  // to MAX_INSTANCES_PER_PATTERN representative pages per pattern.
  const patternTracker = new PatternTracker();
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
  if (startOrigin) {
    try {
      const spaRoutes = await detectSPARoutes(tabId, startOrigin);
      if (spaRoutes.length > 0) {
        log.info(`SPA detector seeded ${spaRoutes.length} routes into BFS queue`);
        for (const routeUrl of spaRoutes) {
          if (!visitedUrls.has(routeUrl) && patternTracker.shouldExplore(routeUrl).allowed) {
            queue.push({ url: routeUrl, depth: Math.min(1, maxDepth - 1) });
          }
        }
      }
    } catch { /* non-fatal — SPA seeding is best-effort */ }
  }

  while (queue.length > 0 && visitedUrls.size < maxPages) {
    if (signal?.aborted) break;
    const entry = queue.shift();
    if (!entry) break;

    const { url, depth } = entry;
    if (visitedUrls.has(url)) continue;

    // ── Pattern deduplication: skip if we already have enough instances ──
    const { pattern: urlPattern, allowed: patternAllowed } = patternTracker.shouldExplore(url);
    if (!patternAllowed) {
      log.debug(`Skipping "${url}" — pattern "${urlPattern}" already has ${patternTracker.count(urlPattern)} instances`);
      visitedUrls.add(url); // Mark as visited so we don't re-queue
      continue;
    }
    patternTracker.record(urlPattern);
    visitedUrls.add(url);

    try {
      const navStart = Date.now();
      await navigateToUrl(tabId, url);
      await delay(ACTION_DELAY_MS);
      const pageLoadTimeMs = Date.now() - navStart;

      // ── 1. Reveal hidden content ─────────────────────────────────────────
      // Hover nav dropdowns + scroll through page to trigger lazy-loaded
      // sections, then scroll back to top before scanning.
      await revealPageContent(tabId);

      // ── 2. Read live page state from content script ──────────────────────
      // Use document.title (not chrome.tabs.title) — SPAs update document.title
      // via JS after status=complete, so chrome.tabs.title is often stale ("...").
      const snapshot = await getPageSnapshot(tabId);
      const currentUrl = snapshot?.url ?? url;
      // document.title is often stale in SPAs (shows "..." or the previous page title).
      // Fall back to the first visible <h1> heading which is far more reliable.
      let currentTitle = snapshot?.title ?? '';
      if (!currentTitle || currentTitle === '...' || currentTitle === 'about:blank') {
        // Pre-fetch metadata early so we can use headings as title fallback
        const earlyMeta = await scanPageMetadata(tabId);
        if (earlyMeta.headings.length > 0) {
          currentTitle = earlyMeta.headings[0];
        }
      }

      // Skip pages that navigated outside the origin
      if (startOrigin && !currentUrl.startsWith(startOrigin)) {
        log.debug(`Skipping off-origin navigation: ${currentUrl}`);
        continue;
      }

      // Auth-wall guard — if the tester got bounced to /login mid-run (session
      // expired, click triggered logout), abort instead of mindlessly clicking
      // around the login form.
      const startedOnAuthPage = AUTH_WALL_RX.test(startUrl);
      if (!startedOnAuthPage && AUTH_WALL_RX.test(currentUrl)) {
        log.warn(`Auth wall detected at ${currentUrl} — exploration session likely expired. Aborting.`);
        throw new Error(`Exploration hit an auth wall at ${currentUrl}. Sign in to the app and re-run exploration.`);
      }

      // ── 3. Scan elements + forms + href links + page metadata + new detectors in parallel ─
      // Snapshot HAR entries before page scan to isolate page-load API calls
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

      // ── 3a. Skip error pages — don't pollute graph with 404/500 pages ──
      if (pageTypeInfo.isErrorPage) {
        log.info(`Skipping error page (${pageTypeInfo.httpStatus ?? 'unknown status'}): ${currentUrl}`);
        continue;
      }

      const node = addNode(graph, currentUrl, currentTitle, elements.length, formFields);

      // Enrich node with page structural context
      if (pageMetadata.breadcrumb) node.breadcrumb = pageMetadata.breadcrumb;
      if (pageMetadata.headings.length > 0) node.headings = pageMetadata.headings;

      // Enrich node with new exploration data
      node.pageType = pageTypeInfo.pageType;
      node.isErrorPage = pageTypeInfo.isErrorPage || undefined;
      node.httpStatus = pageTypeInfo.httpStatus;
      if (pageActions.length > 0) node.actions = pageActions;
      if (dataTables.length > 0) node.dataTables = dataTables;
      // Store URL pattern if this is a parameterized route
      if (urlPattern !== currentUrl) node.urlPattern = urlPattern;
      // Store page load timing for adaptive timeouts in test execution
      node.loadTimeMs = pageLoadTimeMs;
      // Store wizard/stepper steps if detected
      if (wizardSteps.length > 0) node.wizardSteps = wizardSteps;
      // Apply conditional field visibility rules to form fields
      if (conditionalFields.length > 0 && node.formFields) {
        for (const rule of conditionalFields) {
          const field = node.formFields.find((f) => f.selector === rule.fieldSelector);
          if (field) {
            field.visibleWhen = { fieldSelector: rule.triggerSelector, fieldValue: rule.triggerValue };
          }
        }
      }

      // ── 3b. Capture API endpoints observed during page load ──────────
      if (cdpAvailable) {
        const allEntries = getHAREntries(tabId);
        const pageLoadEntries = allEntries.slice(harBefore);
        const apiEndpoints = extractAPIEndpoints(pageLoadEntries, 'page_load');
        if (apiEndpoints.length > 0) {
          node.apiEndpoints = [...(node.apiEndpoints ?? []), ...apiEndpoints];
        }

        // ── 3c. Run accessibility audit on this page via CDP AX tree ────
        try {
          const a11yResult = await runAccessibilityAudit(tabId, currentUrl, currentTitle);
          if (a11yResult.issues.length > 0) {
            a11yResults.push(a11yResult);
            log.info(`A11y: ${a11yResult.summary.total} issues on "${currentTitle || currentUrl}" (${a11yResult.summary.critical} critical)`);
          }
        } catch {
          // Non-fatal — a11y audit failure shouldn't block exploration
        }
      }

      onProgress?.({
        pagesVisited: visitedUrls.size,
        elementsFound: elements.length,
        edgesRecorded: graph.edges.length,
        currentPage: currentTitle || currentUrl,
        status: 'running',
      });

      // ── 4. Enqueue discovered href links (depth-independent) ─────────────
      // This is the most reliable way to discover all same-origin pages —
      // reading <a href> directly without clicking anything.
      for (const link of hrefLinks) {
        if (!visitedUrls.has(link.url)) {
          // Always record the edge (even if we won't explore the destination)
          addEdge(graph, currentUrl, link.url, 'link', 'a[href]', link.text);
          // Only enqueue for exploration if the URL pattern hasn't been saturated
          if (patternTracker.shouldExplore(link.url).allowed) {
            queue.push({ url: link.url, depth: depth + 1 });
          }
        }
      }

      if (depth >= maxDepth) continue;

      // ── 5. Click-based discovery for JS-only navigation ──────────────────
      // In agent mode: AI ranks which elements to click (smart, focused).
      // In standard mode: click filtered interactive elements (comprehensive).
      let targets: Array<{ selector: string; text?: string; ariaLabel?: string; description?: string }>;
      if (useAgentMode) {
        const agentActions = await getAgentActions(
          currentUrl,
          currentTitle,
          elements,
          visitedUrls,
          getVisitedForPage(currentUrl),
          aiClient!
        );
        if (agentActions.length === 0) {
          log.info(`Agent mode: no high-value actions on "${currentTitle || currentUrl}" — using standard fallback`);
          targets = selectExplorationTargets(elements, getVisitedForPage(currentUrl), { includeDangerous });
        } else {
          log.info(`Agent mode: clicking ${agentActions.length} AI-ranked elements on "${currentTitle || currentUrl}"`);
          targets = agentActions.map((a) => {
            // Look up the element's visible text from scanned elements so edge labels are meaningful
            const matchedEl = elements.find((el) => el.selector === a.selector);
            return {
              selector: a.selector,
              text: matchedEl?.text || undefined,
              ariaLabel: matchedEl?.ariaLabel || undefined,
              description: a.description,
            };
          });
        }
      } else {
        targets = selectExplorationTargets(elements, getVisitedForPage(currentUrl), { includeDangerous });
      }
      const pageExplorationStart = Date.now();

      for (let ti = 0; ti < targets.length; ti++) {
        const target = targets[ti];
        if (signal?.aborted) break;
        // Enforce per-page time budget
        if (Date.now() - pageExplorationStart > PAGE_EXPLORATION_BUDGET_MS) {
          log.info(`Page exploration budget exceeded on ${currentUrl}, moving on (${ti}/${targets.length} targets explored)`);
          break;
        }

        const pageVisited = getVisitedForPage(currentUrl);
        if (pageVisited.has(target.selector)) continue;
        pageVisited.add(target.selector);
        log.info(`Clicking target ${ti + 1}/${targets.length} on "${currentTitle || currentUrl}": ${target.description ?? target.selector}`);

        try {
          // Wrap each click exploration in a timeout to prevent hanging
          await withTimeout(SINGLE_CLICK_TIMEOUT_MS, async () => {
            const beforeUrl = currentUrl;
            await sendToContentScript(tabId, {
              type: 'EXECUTE_ACTION',
              payload: {
                order: 0,
                action: 'click',
                selector: target.selector,
                description: `Explore: ${resolveElementLabel(target)}`,
              },
            });

            await delay(ACTION_DELAY_MS);

            // Read URL from content script — more reliable than chrome.tabs for SPAs
            const afterSnap = await getPageSnapshot(tabId);
            const afterUrl = afterSnap?.url ?? currentUrl;

            if (afterUrl !== beforeUrl) {
              // Stay within the same origin
              if (startOrigin && !afterUrl.startsWith(startOrigin)) {
                await navigateToUrl(tabId, beforeUrl);
                await delay(ACTION_DELAY_MS);
                return;
              }

              addEdge(
                graph,
                beforeUrl,
                afterUrl,
                'click',
                target.selector,
                resolveElementLabel(target)
              );

              if (!visitedUrls.has(afterUrl) && patternTracker.shouldExplore(afterUrl).allowed) {
                queue.push({ url: afterUrl, depth: depth + 1 });
              }

              await navigateToUrl(tabId, beforeUrl);
              await delay(ACTION_DELAY_MS);
            } else {
              // Click didn't navigate — check if a modal/dialog opened
              const modal = await detectModal(tabId);
              if (modal.found) {
                // Only record modals with meaningful content (skip tooltips / empty overlays)
                const hasContent = !!(modal.title?.trim()) || (modal.formFields && modal.formFields.length > 0);
                if (hasContent) {
                  const discovery: ModalDiscovery = {
                    triggerSelector: target.selector,
                    triggerLabel: resolveElementLabel(target),
                    title: modal.title,
                    formFields: modal.formFields,
                    content: modal.content?.slice(0, 300),
                  };
                  // Try submitting the modal form to capture outcomes
                  if (modal.formFields && modal.formFields.length > 0) {
                    try {
                      const modalElements = await scanPage(tabId);
                      const modalSubmit = findSubmitButton(modalElements);
                      if (modalSubmit) {
                        await sendToContentScript(tabId, {
                          type: 'EXECUTE_ACTION',
                          payload: { order: 0, action: 'click', selector: modalSubmit.selector, description: 'Explore: modal empty submit' },
                        });
                        await delay(ACTION_DELAY_MS);
                        const outcome = await captureFormOutcome(tabId, currentUrl, [], modalSubmit.selector);
                        discovery.formOutcome = outcome;
                        log.info(`Modal form outcome: ${outcome.result} via "${discovery.triggerLabel}"`);
                      }
                    } catch (modalErr) {
                      log.debug('Modal form exploration failed', { url: currentUrl, trigger: target.selector, err: modalErr instanceof Error ? modalErr.message : String(modalErr) });
                    }
                  }

                  if (!node.modals) node.modals = [];
                  // Avoid duplicate modal entries for the same trigger
                  if (!node.modals.some((m) => m.triggerSelector === target.selector)) {
                    node.modals.push(discovery);
                    log.info(`Modal discovered via "${discovery.triggerLabel}" on ${currentUrl}`);
                  }
                }
                // Dismiss the modal (press Escape, then click backdrop as fallback)
                await dismissModalSafe(tabId);
              }
            }
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('timeout') || msg.includes('Timeout')) {
            log.debug(`Exploration click timed out: ${target.selector}`);
            // After a timeout, try to recover by navigating back to the page
            try {
              await navigateToUrl(tabId, currentUrl);
              await delay(ACTION_DELAY_MS);
            } catch { /* non-fatal */ }
          } else {
            log.debug(`Element interaction failed: ${target.selector}`, err);
          }
        }
      }

      // ── 6. Form interaction discovery ────────────────────────────────
      // Try interacting with form fields to learn what happens on submission.
      // This captures success states, validation errors, and navigation outcomes.
      if (formFields.length > 0 && depth <= maxDepth) {
        try {
          await exploreFormSubmission(tabId, currentUrl, formFields, elements, graph);
          // Navigate back to the page after form exploration
          await navigateToUrl(tabId, currentUrl);
          await delay(ACTION_DELAY_MS);
        } catch (err) {
          log.debug('Form exploration failed', { url: currentUrl, err });
        }
      }

      await saveGraphIncremental(graph);
    } catch (err) {
      log.error(`Exploration failed for ${url}`, err);
    }
  }

  // ── Final full save to ensure consistency ────────────────────────────────
  await saveGraph(graph);

  // ── Detach CDP session ──────────────────────────────────────────────────
  if (cdpAvailable) {
    try {
      await detach(tabId);
      log.info('CDP detached after exploration');
    } catch { /* non-fatal */ }
  }

  onProgress?.({
    pagesVisited: visitedUrls.size,
    elementsFound: graph.nodes.reduce((sum, n) => sum + n.elementCount, 0),
    edgesRecorded: graph.edges.length,
    currentPage: '',
    status: 'done',
  });

  return { graph, a11yResults };
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
    await sendToContentScript(tabId, {
      type: 'EXECUTE_ACTION',
      payload: { order: 0, action: 'click', selector: submitButton.selector, description: 'Explore: empty form submit' },
    });
    await delay(ACTION_DELAY_MS);

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
      await delay(ACTION_DELAY_MS);
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

      await sendToContentScript(tabId, {
        type: 'EXECUTE_ACTION',
        payload: {
          order: 0,
          action,
          selector: field.selector,
          value: action === 'check' ? undefined : testValue,
          description: `Explore: fill ${field.label || field.name || field.type}`,
        },
      });
      filledSelectors.push(field.selector);
      await delay(300);
    }

    if (filledSelectors.length > 0) {
      const harBeforeFilled = cdpOn ? getHAREntries(tabId).length : 0;
      await sendToContentScript(tabId, {
        type: 'EXECUTE_ACTION',
        payload: { order: 0, action: 'click', selector: submitButton.selector, description: 'Explore: filled form submit' },
      });
      await delay(ACTION_DELAY_MS);

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

function findSubmitButton(elements: InteractiveElement[]): InteractiveElement | undefined {
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
    // Many UI frameworks show toasts/snackbars after a short animation delay.
    // Use adaptive delay based on observed page speed when available.
    await delay(getAdaptiveDelay(800));
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

function generateTestValue(field: FormField): string | undefined {
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
    await sendToContentScript(tabId, {
      type: 'EXECUTE_ACTION',
      payload: { order: 0, action: 'press_key', key: 'Escape', description: 'Close modal' },
    });
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
          await sendToContentScript(tabId, {
            type: 'EXECUTE_ACTION',
            payload: { order: 0, action: 'click', selector: sel, description: 'Close modal via button', timeout: 1000 },
          });
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
