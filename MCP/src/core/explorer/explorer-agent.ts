import type { Page } from 'playwright';
import type { InteractionGraph, InteractiveElement, FormField, ModalDiscovery, ExplorationProgress } from '../../storage/schemas.js';
import type { AIClientInterface } from '../ai/ai-client.js';
import { createGraph, addNode, addEdge, saveGraph, loadGraph } from './interaction-graph.js';
import { getPageSnapshotFromPage, scanFormFieldsFromPage } from '../../browser/playwright-adapter.js';
import { getAgentActions } from './agent-explorer.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('explorer');
const ACTION_DELAY_MS = 1000;

// Selectors that indicate a modal/dialog overlay is open
const MODAL_SELECTORS = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[aria-modal="true"]',
  '.modal.show',
  '.modal[style*="display: block"]',
  '.MuiDialog-root',
  '.ant-modal-wrap',
  '.chakra-modal__overlay',
  '[data-radix-dialog-overlay]',
  '.ReactModal__Content',
];

// Selectors for buttons that likely trigger modals (not navigation)
const MODAL_TRIGGER_ATTRS = [
  '[data-toggle="modal"]',
  '[data-bs-toggle="modal"]',
  '[aria-haspopup="dialog"]',
  '[aria-controls]',
];

export interface ExploreOptions {
  maxDepth?: number;
  maxPages?: number;
  startUrl?: string;
  fresh?: boolean;
  /**
   * When true, the AI ranks which elements to click on each page instead of
   * clicking every visible interactive element. Produces higher quality
   * exploration graphs with fewer redundant interactions.
   * Requires aiClient to be provided.
   */
  agentMode?: boolean;
  /** Required when agentMode is true. */
  aiClient?: AIClientInterface;
  onProgress?: (progress: ExplorationProgress) => void;
  signal?: AbortSignal;
}

export async function exploreApp(page: Page, options: ExploreOptions = {}): Promise<InteractionGraph> {
  const { maxDepth = 3, maxPages = 500, startUrl, fresh = false, agentMode = false, aiClient, onProgress, signal } = options;
  const useAgentMode = agentMode && !!aiClient;

  let graph = (await loadGraph()) ?? createGraph();

  const url = startUrl ?? page.url();
  if (startUrl) {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  }

  let startOrigin = '';
  try { startOrigin = new URL(url).origin; } catch { /* ignore */ }

  const visitedUrls = new Set<string>(fresh ? [] : graph.nodes.map((n) => n.url));
  const queue: Array<{ url: string; depth: number }> = [{ url, depth: 0 }];

  while (queue.length > 0 && visitedUrls.size < maxPages) {
    if (signal?.aborted) break;
    const entry = queue.shift();
    if (!entry) break;
    if (visitedUrls.has(entry.url)) continue;
    visitedUrls.add(entry.url);

    try {
      await page.goto(entry.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await delay(ACTION_DELAY_MS);

      const snapshot = await getPageSnapshotFromPage(page);
      const currentUrl = snapshot.url;
      const currentTitle = snapshot.title;

      if (startOrigin && !currentUrl.startsWith(startOrigin)) continue;

      const formFields = await scanFormFieldsFromPage(page);
      const node = addNode(graph, currentUrl, currentTitle, snapshot.elements.length, formFields);

      onProgress?.({
        pagesVisited: visitedUrls.size,
        elementsFound: snapshot.elements.length,
        edgesRecorded: graph.edges.length,
        currentPage: currentTitle || currentUrl,
        status: 'running',
      });

      // Extract same-origin links
      const links = await page.evaluate((origin) => {
        return Array.from(document.querySelectorAll('a[href]'))
          .map((a) => { try { return new URL((a as HTMLAnchorElement).href).toString(); } catch { return ''; } })
          .filter((href) => href.startsWith(origin) && !href.match(/\.(pdf|jpg|png|gif|svg|mp4|zip)$/i));
      }, startOrigin);

      for (const link of [...new Set(links)]) {
        if (!visitedUrls.has(link)) {
          queue.push({ url: link, depth: entry.depth + 1 });
          addEdge(graph, currentUrl, link, 'link', 'a[href]', 'Link');
        }
      }

      if (entry.depth >= maxDepth) {
        await saveGraph(graph);
        continue;
      }

      // ── Click-based interaction discovery ────────────────────────────────
      // In agent mode: AI ranks which elements to click (smart, focused).
      // In standard mode: click all visible interactive elements (comprehensive).

      // Deduplicate by selector across the full element set
      const seenSelectors = new Set<string>();
      const allClickable = snapshot.elements.filter((el) => {
        if (!el.visible) return false;
        if (!['button', 'a'].includes(el.tag) && el.role !== 'button' && el.role !== 'tab') return false;
        if (seenSelectors.has(el.selector)) return false;
        seenSelectors.add(el.selector);
        return true;
      });

      // In agent mode, get AI-ranked subset; otherwise use full deduplicated list.
      let targetsToClick: Array<{ selector: string; text?: string; ariaLabel?: string; description?: string }>;
      if (useAgentMode) {
        const agentActions = await getAgentActions(
          page,
          snapshot.elements,
          visitedUrls,
          seenSelectors, // selectors already seen on this page
          aiClient!
        );
        if (agentActions.length === 0) {
          log.info(`Agent mode: no high-value actions found on "${currentTitle || currentUrl}" — using standard fallback`);
          targetsToClick = allClickable;
        } else {
          log.info(`Agent mode: clicking ${agentActions.length} AI-ranked elements on "${currentTitle || currentUrl}"`);
          targetsToClick = agentActions.map((a) => ({ selector: a.selector, description: a.description }));
        }
      } else {
        targetsToClick = allClickable;
      }

      for (const target of targetsToClick) {
        try {
          const beforeUrl = page.url();
          await page.click(target.selector, { timeout: 3000 }).catch(() => {});
          await delay(500);
          const afterUrl = page.url();

          if (afterUrl !== beforeUrl && startOrigin && afterUrl.startsWith(startOrigin)) {
            // Navigation occurred — record edge and enqueue
            const label = target.description ?? (target as any).text ?? (target as any).ariaLabel ?? 'Click';
            addEdge(graph, beforeUrl, afterUrl, 'click', target.selector, label);
            if (!visitedUrls.has(afterUrl)) queue.push({ url: afterUrl, depth: entry.depth + 1 });
            await page.goto(beforeUrl, { waitUntil: 'domcontentloaded' });
            await delay(500);
          } else if (afterUrl === beforeUrl) {
            // URL unchanged — check if a modal/overlay opened
            const label = target.description ?? (target as any).text ?? (target as any).ariaLabel ?? '';
            const modal = await discoverModal(page, target.selector, label);
            if (modal) {
              if (!node.modals) node.modals = [];
              const alreadyRecorded = node.modals.some((m) => m.triggerSelector === modal.triggerSelector);
              if (!alreadyRecorded) {
                node.modals.push(modal);
                log.info(`Modal discovered on ${currentTitle || currentUrl}: "${modal.title ?? modal.triggerLabel}" (${modal.formFields?.length ?? 0} fields)`);
              }
              await closeModal(page);
              await delay(300);
            }
          }
        } catch {
          /* non-fatal — continue to next element */
        }
      }

      await saveGraph(graph);
    } catch (err) {
      log.error(`Exploration failed for ${entry.url}`, err);
    }
  }

  onProgress?.({
    pagesVisited: visitedUrls.size,
    elementsFound: graph.nodes.reduce((s, n) => s + n.elementCount, 0),
    edgesRecorded: graph.edges.length,
    currentPage: '',
    status: 'done',
  });
  return graph;
}

// ─── Modal Discovery ──────────────────────────────────────────────────────────

/**
 * After clicking a trigger element, check if a modal/dialog opened.
 * If so, scan its form fields and title, then return a ModalDiscovery record.
 * Returns null if no modal was detected.
 */
async function discoverModal(page: Page, triggerSelector: string, triggerLabel: string): Promise<ModalDiscovery | null> {
  // Check if any known modal container is now visible
  let modalEl: import('playwright').Locator | null = null;

  for (const sel of MODAL_SELECTORS) {
    try {
      const locator = page.locator(sel).first();
      const visible = await locator.isVisible({ timeout: 1000 }).catch(() => false);
      if (visible) { modalEl = locator; break; }
    } catch {
      continue;
    }
  }

  if (!modalEl) return null;

  // Extract modal title from aria-labelledby, h1/h2/h3 inside the dialog, or [role="heading"]
  let title: string | undefined;
  try {
    const labelledById = await modalEl.evaluate((el) => el.getAttribute('aria-labelledby'));
    if (labelledById) {
      const labelEl = page.locator(`#${labelledById}`);
      title = (await labelEl.textContent({ timeout: 1000 }).catch(() => null)) ?? undefined;
    }
    if (!title) {
      const heading = modalEl.locator('h1, h2, h3, [role="heading"]').first();
      title = (await heading.textContent({ timeout: 1000 }).catch(() => null)) ?? undefined;
    }
    title = title?.trim().slice(0, 100);
  } catch {}

  // Capture text content snapshot for context
  let content: string | undefined;
  try {
    const text = await modalEl.textContent({ timeout: 1000 });
    content = text?.replace(/\s+/g, ' ').trim().slice(0, 300);
  } catch {}

  // Scan form fields inside the modal
  let formFields: FormField[] = [];
  try {
    formFields = await modalEl.evaluate((root) => {
      const fields: any[] = [];
      root.querySelectorAll('input:not([type="hidden"]), select, textarea').forEach((el) => {
        const input = el as HTMLInputElement;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;

        let label = '';
        const labelEl = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
        if (labelEl) label = labelEl.textContent?.trim() ?? '';
        if (!label) label = el.getAttribute('aria-label') ?? el.getAttribute('placeholder') ?? '';

        const field: any = {
          selector: el.id ? `#${el.id}` : el.getAttribute('name') ? `${el.tagName.toLowerCase()}[name="${el.getAttribute('name')}"]` : el.tagName.toLowerCase(),
          type: el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : input.type || 'text',
          name: el.getAttribute('name') ?? undefined,
          label: label || undefined,
          placeholder: el.getAttribute('placeholder') ?? undefined,
          required: input.required,
        };
        if (input.minLength > 0) field.minLength = input.minLength;
        if (input.maxLength > 0 && input.maxLength < 524288) field.maxLength = input.maxLength;
        if (el.tagName === 'SELECT') {
          field.options = Array.from((el as HTMLSelectElement).options).map((o) => o.text).filter((t) => t.trim());
        }
        fields.push(field);
      });
      return fields;
    });
  } catch {}

  return {
    triggerSelector,
    triggerLabel,
    title: title || undefined,
    formFields: formFields.length > 0 ? formFields : undefined,
    content: content || undefined,
  };
}

/**
 * Close an open modal/dialog via Escape key or a visible close button.
 */
async function closeModal(page: Page): Promise<void> {
  // Try close button first (more reliable than Escape for some frameworks)
  const closeSelectors = [
    '[aria-label="Close"]',
    '[aria-label="close"]',
    '[aria-label="Dismiss"]',
    '.modal-close',
    '.MuiDialogTitle-root button',
    '.ant-modal-close',
    '[data-radix-dialog-close]',
    'button[class*="close"]',
  ];
  for (const sel of closeSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 500 })) {
        await btn.click({ timeout: 1000 });
        return;
      }
    } catch {}
  }
  // Fall back to Escape
  await page.keyboard.press('Escape').catch(() => {});
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
