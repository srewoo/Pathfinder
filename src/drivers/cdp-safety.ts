/**
 * Installs §7's safety controls into a live CDP session.
 *
 * `Fetch.enable` puts every request under our decision. Requests the policy
 * refuses are aborted before they reach the network, and every mutating request
 * — permitted or refused — lands in the ledger.
 *
 * The failure mode this guards against is a run that quietly writes to
 * production. That has to be impossible by construction rather than by
 * convention, which is why the interception lives here and not at a call site.
 */
import type { NetworkRequest, NetworkResponse } from '../core/driver';
import type { OriginPolicy } from '../core/safety/origin-policy';
import { decide, isMutating, isPageCritical } from '../core/safety/origin-policy';
import type { MutationLedger } from '../core/safety/mutation-ledger';
import { entryFor } from '../core/safety/mutation-ledger';
import { registerSafetyInstaller } from '../core/safety/safety-port';
import { createLogger } from '../utils/logger';
import { redactUrlForLog } from '../utils/url-redact';

const log = createLogger('cdp-safety');

interface FetchRequestPausedEvent {
  requestId: string;
  request: { url: string; method: string; headers?: Record<string, string> };
  resourceType?: string;
  responseStatusCode?: number;
}

/**
 * `Sec-Fetch-Dest`, whatever casing the browser used.
 *
 * Header names are case-insensitive and CDP passes them through as received, so a
 * fixed-case lookup silently misses — and a missed header means an embedded iframe
 * is mistaken for the crawler navigating away.
 */
function fetchDestOf(headers: Record<string, string> | undefined): string | undefined {
  if (!headers) return undefined;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'sec-fetch-dest') return v;
  }
  return undefined;
}

export interface SafetySession {
  /** Stop intercepting and remove the listener. Idempotent. */
  dispose(): Promise<void>;
  /** Requests aborted so far. */
  abortedCount(): number;
  /**
   * Aborted requests whose loss breaks the page (scripts, documents, API calls).
   *
   * Non-empty means the app under test may not have booted, so anything the run
   * observed afterwards describes the policy's damage rather than the app. A
   * caller that reports findings without checking this reports fiction.
   */
  criticalBlocks(): readonly string[];
}

/**
 * Attach request interception for `tabId`, enforcing `policy` and recording to
 * `ledger`.
 *
 * Returns a disposer. Callers MUST dispose, or the listener outlives the run
 * (CLAUDE.md §11.1 — listener accumulation is a leak).
 */
export async function installSafety(
  tabId: number,
  policy: OriginPolicy,
  ledger: MutationLedger,
  hooks: {
    onRequest?: (r: NetworkRequest) => void;
    onResponse?: (r: NetworkResponse) => void;
    now?: () => number;
  } = {}
): Promise<SafetySession> {
  const now = hooks.now ?? (() => Date.now());
  let aborted = 0;
  let disposed = false;
  /** Bounded so a page that retries a blocked bundle forever cannot grow this. */
  const CRITICAL_BLOCK_CAP = 20;
  const critical: string[] = [];
  /** Distinct blocked requests already logged, so repeats stay quiet. */
  const loggedBlocks = new Set<string>();
  /** How many times each distinct request was blocked, reported once on dispose. */
  const repeatedBlocks = new Map<string, number>();

  const listener = (
    source: chrome.debugger.Debuggee,
    method: string,
    params?: object
  ): void => {
    if (source.tabId !== tabId) return;

    if (method === 'Fetch.requestPaused') {
      void handlePaused(params as FetchRequestPausedEvent);
      return;
    }
  };

  async function handlePaused(ev: FetchRequestPausedEvent): Promise<void> {
    const { requestId } = ev;
    const url = ev.request?.url ?? '';
    const method = (ev.request?.method ?? 'GET').toUpperCase();

    // Response stage — record the status against the ledger entry and continue.
    if (ev.responseStatusCode !== undefined) {
      if (isMutating(method)) ledger.noteStatus(url, method, ev.responseStatusCode);
      hooks.onResponse?.({
        requestId,
        url,
        method,
        status: ev.responseStatusCode,
      });
      await continueRequest(tabId, requestId);
      return;
    }

    const decision = decide(
      { url, method, resourceType: ev.resourceType, destination: fetchDestOf(ev.request?.headers) },
      policy
    );

    // Only mutating verbs and refusals are ledger-worthy. Recording every GET
    // would bury the signal that matters under page-load noise.
    if (isMutating(method) || !decision.allow) {
      ledger.record(entryFor({ url, method }, decision), now());
    }

    hooks.onRequest?.({ requestId, url, method, resourceType: ev.resourceType });

    if (!decision.allow) {
      aborted++;
      // One line per distinct request, not one per occurrence. A page that retries
      // a blocked asset — or a crawl that revisits it every thirty seconds — filled
      // the log with the same ERROR until the real output was unreadable.
      const key = `${method} ${url}`;
      const firstTime = !loggedBlocks.has(key);
      if (firstTime) loggedBlocks.add(key);
      repeatedBlocks.set(key, (repeatedBlocks.get(key) ?? 0) + 1);

      const safeUrl = redactUrlForLog(url);
      if (firstTime && isPageCritical(ev.resourceType)) {
        // Loud, not debug: this is the difference between "we declined a tracker"
        // and "the app never loaded and everything after this is noise".
        log.error(
          `BLOCKED ${ev.resourceType} ${method} ${safeUrl} — ${decision.reason}. ` +
            `The page may not function; results from this run are suspect.`
        );
        if (critical.length < CRITICAL_BLOCK_CAP) {
          critical.push(`${ev.resourceType} ${method} ${safeUrl} (${decision.reason})`);
        }
      } else if (firstTime) {
        log.warn(`BLOCKED ${method} ${safeUrl} — ${decision.reason}`);
      }
      await failRequest(tabId, requestId);
      return;
    }

    await continueRequest(tabId, requestId);
  }

  chrome.debugger.onEvent.addListener(listener);

  // Request stage only for the decision; we opt into the response stage as well
  // so mutating requests can have their status recorded.
  await send(tabId, 'Fetch.enable', {
    patterns: [
      { urlPattern: '*', requestStage: 'Request' },
      { urlPattern: '*', requestStage: 'Response' },
    ],
  });

  log.info(
    `Safety installed on tab ${tabId}: ${policy.allowedOrigins.length} allowed origin(s), ` +
      `mutations ${policy.allowMutations ? 'ENABLED' : 'blocked'}`
  );

  return {
    async dispose() {
      if (disposed) return;
      disposed = true;
      // Report the repeats once, at the end. Suppressing them during the run must
      // not mean hiding how often they happened.
      const repeats = [...repeatedBlocks.entries()].filter(([, n]) => n > 1);
      if (repeats.length > 0) {
        const worst = repeats.sort((a, b) => b[1] - a[1]).slice(0, 3)
          .map(([k, n]) => `${k} ×${n}`).join('; ');
        log.info(`${repeats.length} blocked request(s) recurred during the run: ${worst}`);
      }
      chrome.debugger.onEvent.removeListener(listener);
      try {
        await send(tabId, 'Fetch.disable', {});
      } catch {
        // Session may already be gone.
      }
    },
    abortedCount() {
      return aborted;
    },
    criticalBlocks() {
      return critical;
    },
  };
}

async function continueRequest(tabId: number, requestId: string): Promise<void> {
  try {
    await send(tabId, 'Fetch.continueRequest', { requestId });
  } catch (err) {
    // A paused request that cannot be continued has usually already been torn
    // down with the frame. Nothing to recover.
    log.debug(`continueRequest failed for ${requestId}`, err);
  }
}

async function failRequest(tabId: number, requestId: string): Promise<void> {
  try {
    await send(tabId, 'Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
  } catch (err) {
    log.debug(`failRequest failed for ${requestId}`, err);
  }
}

function send(tabId: number, method: string, params: object): Promise<unknown> {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

// Register with the core port so `src/core` never imports this module (fix.md §2).
// Session setup calls installRunSafety(), which lands here.
registerSafetyInstaller((tabId, policy, ledger) => installSafety(tabId, policy, ledger));
