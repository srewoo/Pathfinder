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
import type { StepExecutor } from '../core/jobs/job-runner';
import { registerExecutor } from './job-pump';
import { loadGraph, createGraph, saveGraphIncremental } from '../core/explorer/interaction-graph';
import { applyPageResult, explorePage } from '../core/explorer/explore-page-step';
import { driverForTab } from '../core/step-executor';
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
 * Explore one target: navigate, observe, record, and report what it discovered.
 *
 * Idempotent by construction (§4). A replayed step re-navigates and re-observes the
 * same URL, and `applyPageResult` upserts, so the only cost of a replay is time —
 * never duplicate graph nodes or double-counted pages.
 */
export const crawlStepExecutor: StepExecutor = async (target: QueuedTarget, job: Job) => {
  const startedAt = Date.now();
  const tabId = await ensureTab(job);
  const maxDepth = typeof job.config.maxDepth === 'number' ? job.config.maxDepth : 2;

  try {
    if (!isAttached(tabId)) {
      // No session means no execution at all now that the content-script path is
      // gone (§3). Fail the step loudly rather than recording an empty page.
      return {
        outcome: {
          url: target.url,
          elapsedMs: Date.now() - startedAt,
          ok: false,
          error: 'CDP session lost — cannot explore this page',
        },
      };
    }

    const origin = safeOrigin(target.url) ?? '';
    // The real per-page exploration step, extracted from explorer-agent so the
    // pump runs genuine exploration rather than a stripped-down navigate+scan.
    const page = await explorePage(driverForTab(tabId), {
      url: target.url,
      depth: target.depth,
      origin,
      maxDepth,
    });

    if (page.authWall) {
      return {
        outcome: {
          url: target.url,
          elapsedMs: Date.now() - startedAt,
          ok: false,
          error: `Redirected to an auth wall (${page.url}) — configure a login preset`,
        },
      };
    }

    if (page.brokenLink) {
      // A broken page is a FINDING, not a step failure: the crawl worked, the app
      // is wrong. Recording it as a failure would trip the circuit breaker on a
      // site that simply has dead links.
      log.warn(`Broken page: ${page.url} (${page.title})`);
    }

    const graph = (await loadGraph()) ?? createGraph();
    applyPageResult(graph, page, target.via);
    await saveGraphIncremental(graph);

    log.info(
      `Explored ${page.url} (depth ${target.depth}) — ` +
        `${page.formFields.length} field(s), ${page.apiEndpoints.length} API(s), ` +
        `risk ${page.risk.weight}, ${page.nextTargets.length} new target(s)`
    );

    return {
      outcome: {
        url: target.url,
        discovered: page.nextTargets,
        elapsedMs: Date.now() - startedAt,
        ok: true,
      },
      payload: {
        url: page.url,
        title: page.title,
        formFieldCount: page.formFields.length,
        apiCount: page.apiEndpoints.length,
        riskWeight: page.risk.weight,
        riskReasons: page.risk.reasons,
        brokenLink: page.brokenLink,
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
  // Exploration and crawling share the step: both map pages read-only. The
  // click/modal interaction that MUTATES page state stays in the in-memory
  // explorer for now — moving it here would mean claiming a decomposition that
  // has not happened.
  registerExecutor('explore', crawlStepExecutor);
}
