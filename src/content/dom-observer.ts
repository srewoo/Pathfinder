/**
 * Content-script observers: network-request tracking and DOM-idle waiting.
 *
 * Trimmed from 422 lines to the reachable set. The removed 306 lines were a
 * second implementation of things the driver already owns — element waiting,
 * navigation waiting, shadow-DOM/iframe selector fallbacks and cross-origin
 * iframe reporting — none of it imported by anything since execution moved to
 * CDP (fix.md §3). The driver's actionability polling is the one place that logic
 * belongs; keeping a rival copy here invited the two to disagree.
 *
 * What remains is genuinely content-script work: only the page can patch its own
 * `fetch`/`XHR` to know when requests settle.
 */


declare global {
  interface XMLHttpRequest {
    __pathfinder_tracked?: boolean;
  }
}

// ---------------------------------------------------------------------------
// Network idle tracking — intercept fetch/XHR to know when API calls settle

// ---------------------------------------------------------------------------
let _pendingCritical = 0; // API-only requests (excludes analytics/tracking)
let _networkPatched = false;

// Analytics/tracking domains to exclude from critical idle detection
const ANALYTICS_PATTERNS = [
  /google-analytics\.com/i, /googletagmanager\.com/i, /analytics/i,
  /segment\.(com|io)/i, /mixpanel\.com/i, /amplitude\.com/i,
  /hotjar\.com/i, /clarity\.ms/i, /fullstory\.com/i,
  /sentry\.io/i, /bugsnag\.com/i, /datadog/i,
  /intercom\.(com|io)/i, /drift\.com/i, /hubspot\.com/i,
  /facebook\.com\/tr/i, /doubleclick\.net/i, /ads/i,
  /beacon/i, /pixel/i, /tracking/i, /telemetry/i,
];


function isAnalyticsRequest(url: string): boolean {
  return ANALYTICS_PATTERNS.some((p) => p.test(url));
}

export function installNetworkTracker(): void {
  if (_networkPatched) return;
  _networkPatched = true;

  // Intercept fetch — categorize as critical or analytics
  const originalFetch = window.fetch;
  window.fetch = function (...args: Parameters<typeof fetch>) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0] as Request)?.url ?? '';
    const isCritical = !isAnalyticsRequest(url);
    if (isCritical) _pendingCritical++;
    return originalFetch.apply(this, args).finally(() => {
      if (isCritical) _pendingCritical--;
    });
  };

  // Intercept XMLHttpRequest
  const OrigXHR = window.XMLHttpRequest;
  const origOpen = OrigXHR.prototype.open;
  const origSend = OrigXHR.prototype.send;

  OrigXHR.prototype.open = function (this: XMLHttpRequest & { __pathfinder_url?: string }, ...args: any[]) {
    this.__pathfinder_tracked = true;
    this.__pathfinder_url = args[1] as string;
    return origOpen.apply(this, args as any);
  };
  OrigXHR.prototype.send = function (this: XMLHttpRequest & { __pathfinder_url?: string }, ...args: any[]) {
    if (this.__pathfinder_tracked) {
      const isCritical = !isAnalyticsRequest(this.__pathfinder_url ?? '');
      if (isCritical) _pendingCritical++;
      this.addEventListener('loadend', () => {
        if (isCritical) _pendingCritical--;
      }, { once: true });
    }
    return origSend.apply(this, args as any);
  };
}

/**
 * Wait for the DOM to stop mutating — useful after click/navigate to ensure
 * the SPA has finished rendering before the next step executes.
 * Also gates on network idle to ensure in-flight API calls have settled.
 */
export function waitForDOMIdle(settleMs = 300, timeout = 5000): Promise<void> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const maxTimer = setTimeout(() => {
      idleObs.disconnect();
      resolve();
    }, timeout);

    function tryResolve() {
      // Gate on CRITICAL requests only. Analytics beacons (Segment, Datadog,
      // tracking pixels) are long-lived by design and some never resolve, so
      // waiting on every in-flight request charged up to the full timeout per
      // step on any app with telemetry. `_pendingCritical` is what the analytics
      // classification below was built for — until now nothing read it.
      if (_pendingCritical > 0) {
        const elapsed = Date.now() - startTime;
        const remaining = Math.max(0, timeout - elapsed);
        const networkCap = Math.min(remaining, 5000);

        if (networkCap <= 0) {
          idleObs.disconnect();
          clearTimeout(maxTimer);
          resolve();
          return;
        }

        const networkWait = setTimeout(() => {
          idleObs.disconnect();
          clearTimeout(maxTimer);
          resolve();
        }, networkCap);

        const networkCheck = setInterval(() => {
          if (_pendingCritical === 0) {
            clearInterval(networkCheck);
            clearTimeout(networkWait);
            idleObs.disconnect();
            clearTimeout(maxTimer);
            resolve();
          }
        }, 50);
        return;
      }
      idleObs.disconnect();
      clearTimeout(maxTimer);
      resolve();
    }

    function resettle() {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(tryResolve, settleMs);
    }

    const idleObs = new MutationObserver(resettle);
    idleObs.observe(document.body, { childList: true, subtree: true, attributes: true });

    // Start the initial settle timer — if nothing mutates, resolve quickly
    resettle();
  });
}
