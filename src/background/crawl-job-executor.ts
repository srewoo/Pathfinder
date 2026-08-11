/**
 * Durable crawl step executor (fix.md §4).
 *
 * This is what makes eviction survival REAL rather than demonstrated. The job
 * machinery and its tests existed, but no executor was ever registered — so the
 * pump would claim a job and immediately fail it with "no executor registered",
 * and every actual crawl still ran as an in-memory loop that eviction destroyed.
 *
 * One step = scan one page and enqueue what it links to. Deliberately small:
 * the smaller the step, the less an eviction costs, and the state that survives
 * is the frontier rather than a half-finished traversal.
 */
import type { Job, QueuedTarget } from '../core/jobs/job-model';
import { normalizeUrl } from '../core/jobs/job-model';
import type { StepExecutor } from '../core/jobs/job-runner';
import { registerExecutor } from './job-pump';
import { scanPageLinks, scanPageMetadata, getPageSnapshot } from '../core/explorer/page-scanner';
import { addEdge, addNode, loadGraph, createGraph, saveGraphIncremental } from '../core/explorer/interaction-graph';
import { executeStep } from '../core/step-executor';
import { initCDPSession } from '../core/cdp/cdp-session';
import { isAttached } from '../core/cdp/cdp-client';
import { createLogger } from '../utils/logger';

const log = createLogger('crawl-job');

/** Tab the durable crawl drives. Created lazily, reused across steps. */
let crawlTabId: number | null = null;

async function ensureTab(job: Job): Promise<number> {
  if (crawlTabId !== null) {
    try {
      await chrome.tabs.get(crawlTabId);
      return crawlTabId;
    } catch {
      // Tab was closed — fall through and make a new one. A resumed job after a
      // browser restart lands here, which is exactly the case §4 exists for.
      crawlTabId = null;
    }
  }

  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  if (tab.id === undefined) throw new Error('Could not create a tab for the crawl job');
  crawlTabId = tab.id;

  // Scope enforcement to the job's own origin (§7). `config.allowedOrigins` is
  // set by whoever enqueued the job; mutations stay off unless asked for.
  const seed = job.frontier[0]?.url ?? job.visited[0];
  await initCDPSession(crawlTabId, {
    startUrl: typeof seed === 'string' ? seed : undefined,
    extraOrigins: Array.isArray(job.config.allowedOrigins)
      ? (job.config.allowedOrigins as string[])
      : undefined,
    allowMutations: job.config.allowMutations === true,
  });

  return crawlTabId;
}

/**
 * Visit one target: navigate, scan, record, and report what it discovered.
 *
 * Idempotent by construction (§4). Re-running a step after a mid-commit crash
 * re-navigates and re-scans the same URL, and `addNode` upserts, so the only cost
 * of a replay is time — never duplicate graph nodes or double-counted pages.
 */
export const crawlStepExecutor: StepExecutor = async (target: QueuedTarget, job: Job) => {
  const startedAt = Date.now();
  const tabId = await ensureTab(job);

  const maxDepth = typeof job.config.maxDepth === 'number' ? job.config.maxDepth : 2;

  try {
    const nav = await executeStep(
      { order: 0, action: 'navigate', value: target.url, description: `Visit ${target.url}` },
      tabId
    );
    if (!nav.success) {
      return {
        outcome: {
          url: target.url,
          elapsedMs: Date.now() - startedAt,
          ok: false,
          error: nav.error ?? 'navigation failed',
        },
      };
    }

    if (!isAttached(tabId)) {
      // No session means no execution at all now that the content-script path is
      // gone (§3). Fail the step loudly rather than recording an empty page.
      return {
        outcome: {
          url: target.url,
          elapsedMs: Date.now() - startedAt,
          ok: false,
          error: 'CDP session lost — cannot scan this page',
        },
      };
    }

    const snapshot = await getPageSnapshot(tabId);
    const origin = safeOrigin(target.url);
    const links = origin ? await scanPageLinks(tabId, origin).catch(() => []) : [];

    const graph = (await loadGraph()) ?? createGraph();
    const pageUrl = snapshot?.url ?? target.url;
    // addNode upserts, which is what makes a replayed step harmless (§4).
    addNode(graph, pageUrl, snapshot?.title ?? '', links.length);
    if (target.via) {
      addEdge(graph, target.via, pageUrl, 'link', '', target.via);
    }
    await saveGraphIncremental(graph);

    // Only enqueue deeper targets while within budget — the frontier is
    // persisted, so an unbounded one is a durable problem, not a transient one.
    const discovered: QueuedTarget[] =
      target.depth >= maxDepth
        ? []
        : links
            .filter((l) => safeOrigin(l.url) === origin)
            .map((l) => ({
              url: normalizeUrl(l.url),
              depth: target.depth + 1,
              via: snapshot?.url ?? target.url,
            }));

    log.info(
      `Crawled ${target.url} (depth ${target.depth}) — ${discovered.length} new target(s)`
    );

    return {
      outcome: {
        url: target.url,
        discovered,
        elapsedMs: Date.now() - startedAt,
        ok: true,
      },
      payload: {
        url: pageUrl,
        title: snapshot?.title ?? '',
        linkCount: links.length,
        // Persisted with the step result, so a resumed run can report what it
        // found without re-visiting.
        headings: (await scanPageMetadata(tabId).catch(() => ({ headings: [] }))).headings ?? [],
      },
    };
  } catch (err) {
    return {
      outcome: {
        url: target.url,
        elapsedMs: Date.now() - startedAt,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
};

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Release the crawl tab. Called when a job finishes or is abandoned. */
export async function closeCrawlTab(): Promise<void> {
  if (crawlTabId === null) return;
  const id = crawlTabId;
  crawlTabId = null;
  try {
    await chrome.tabs.remove(id);
  } catch {
    // Already gone.
  }
}

/**
 * Register the executors.
 *
 * MUST run at service-worker top level: after an eviction the worker restarts and
 * has to re-register before the pump's alarm fires, or a perfectly resumable job
 * fails with "no executor registered" — which would make §4's durability
 * guarantee hold in tests and evaporate in production.
 */
export function installCrawlExecutors(): void {
  registerExecutor('crawl', crawlStepExecutor);
  // Exploration reuses the same step for now: navigate, scan, enqueue. The
  // richer click/modal/form interaction still lives in the in-memory explorer
  // and moves here as part of its decomposition (§4/§13).
  registerExecutor('explore', crawlStepExecutor);
}
