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
import { decide, isMutating } from '../core/safety/origin-policy';
import type { MutationLedger } from '../core/safety/mutation-ledger';
import { entryFor } from '../core/safety/mutation-ledger';
import { registerSafetyInstaller } from '../core/safety/safety-port';
import { createLogger } from '../utils/logger';

const log = createLogger('cdp-safety');

interface FetchRequestPausedEvent {
  requestId: string;
  request: { url: string; method: string };
  resourceType?: string;
  responseStatusCode?: number;
}

export interface SafetySession {
  /** Stop intercepting and remove the listener. Idempotent. */
  dispose(): Promise<void>;
  /** Requests aborted so far. */
  abortedCount(): number;
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

    const decision = decide({ url, method, resourceType: ev.resourceType }, policy);

    // Only mutating verbs and refusals are ledger-worthy. Recording every GET
    // would bury the signal that matters under page-load noise.
    if (isMutating(method) || !decision.allow) {
      ledger.record(entryFor({ url, method }, decision), now());
    }

    hooks.onRequest?.({ requestId, url, method, resourceType: ev.resourceType });

    if (!decision.allow) {
      aborted++;
      log.warn(`BLOCKED ${method} ${url} — ${decision.reason}`);
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
