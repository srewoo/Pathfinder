declare global {
  interface XMLHttpRequest {
    __pathfinder_tracked?: boolean;
  }
}

type ChangeCallback = (mutations: MutationRecord[]) => void;

let observer: MutationObserver | null = null;

export function startObserving(callback: ChangeCallback): void {
  stopObserving();

  observer = new MutationObserver((mutations) => {
    const significant = mutations.filter(
      (m) =>
        m.type === 'childList' ||
        (m.type === 'attributes' && ['class', 'style', 'hidden', 'disabled'].includes(m.attributeName ?? ''))
    );

    if (significant.length > 0) {
      callback(significant);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'disabled', 'aria-hidden'],
  });
}

export function stopObserving(): void {
  observer?.disconnect();
  observer = null;
}

/**
 * querySelector that also searches inside open shadow roots.
 */
function deepQuerySelector(root: Document | ShadowRoot | Element, selector: string): Element | null {
  try {
    const el = (root as ParentNode).querySelector(selector);
    if (el) return el;
  } catch {
    return null;
  }

  // Search inside shadow roots
  const allElements = (root as ParentNode).querySelectorAll('*');
  for (const host of Array.from(allElements)) {
    if (host.shadowRoot) {
      const found = deepQuerySelector(host.shadowRoot, selector);
      if (found) return found;
    }
  }

  return null;
}

/**
 * Try to find an element using a comma-separated list of fallback selectors.
 * Returns the first match from any selector in the list.
 * Also searches inside same-origin iframes if not found in the main document.
 */
function tryFallbackSelectors(selectorStr: string): Element | null {
  const selectors = selectorStr.split(',').map((s) => s.trim()).filter(Boolean);

  // First pass: search main document + shadow roots
  for (const sel of selectors) {
    try {
      const el = deepQuerySelector(document, sel);
      if (el) return el;
    } catch {
      // Invalid selector — skip to next fallback
    }
  }

  // Second pass: search inside same-origin iframes
  return searchIframes(selectors);
}

/**
 * Search inside all same-origin iframes for an element matching any of the selectors.
 * Caches iframe contentDocuments to avoid repeated access.
 */
function searchIframes(selectors: string[]): Element | null {
  const iframes = document.querySelectorAll('iframe');
  for (const iframe of Array.from(iframes)) {
    try {
      const iframeDoc = (iframe as HTMLIFrameElement).contentDocument;
      if (!iframeDoc) continue; // cross-origin or not loaded

      for (const sel of selectors) {
        try {
          const el = deepQuerySelector(iframeDoc, sel);
          if (el) return el;
        } catch {
          // Invalid selector in this context — skip
        }
      }

      // Also search nested iframes (one level deep for performance)
      const nestedIframes = iframeDoc.querySelectorAll('iframe');
      for (const nested of Array.from(nestedIframes)) {
        try {
          const nestedDoc = (nested as HTMLIFrameElement).contentDocument;
          if (!nestedDoc) continue;
          for (const sel of selectors) {
            try {
              const el = deepQuerySelector(nestedDoc, sel);
              if (el) return el;
            } catch {
              // skip
            }
          }
        } catch {
          // cross-origin nested iframe — skip
        }
      }
    } catch {
      // cross-origin iframe — skip
    }
  }
  return null;
}

/**
 * Detect cross-origin iframes on the page and return their src URLs.
 * Used to provide clear error messages when an element can't be found
 * because it might be inside a cross-origin iframe.
 */
export function detectCrossOriginIframes(): string[] {
  const crossOrigin: string[] = [];
  document.querySelectorAll('iframe').forEach((iframe) => {
    const el = iframe as HTMLIFrameElement;
    try {
      // Attempting to access contentDocument throws for cross-origin
      const _doc = el.contentDocument;
      if (!_doc) crossOrigin.push(el.src || '(no src)');
    } catch {
      crossOrigin.push(el.src || '(no src)');
    }
  });
  return crossOrigin;
}

/**
 * Validate at least one selector in a comma-separated list is syntactically valid.
 */
function hasValidSelector(selectorStr: string): boolean {
  const selectors = selectorStr.split(',').map((s) => s.trim()).filter(Boolean);
  for (const sel of selectors) {
    try {
      document.querySelector(sel);
      return true;
    } catch {
      // Try next
    }
  }
  return false;
}

export function waitForElement(selector: string, timeout = 10000): Promise<Element> {
  return new Promise((resolve, reject) => {
    // Validate at least one selector is valid
    if (!hasValidSelector(selector)) {
      reject(new Error(`Invalid CSS selector(s): ${selector}`));
      return;
    }

    // Try fallback selectors immediately
    const el = tryFallbackSelectors(selector);
    if (el) {
      resolve(el);
      return;
    }

    const timer = setTimeout(() => {
      obs.disconnect();
      // Include cross-origin iframe context in error message for better debugging
      const xOriginIframes = detectCrossOriginIframes();
      const iframeHint = xOriginIframes.length > 0
        ? ` Note: ${xOriginIframes.length} cross-origin iframe(s) on page (${xOriginIframes.slice(0, 3).join(', ')}) — element may be inside one of them and is not accessible.`
        : '';
      reject(new Error(`Element not found within ${timeout}ms: ${selector}${iframeHint}`));
    }, timeout);

    const obs = new MutationObserver(() => {
      const found = tryFallbackSelectors(selector);
      if (found) {
        obs.disconnect();
        clearTimeout(timer);
        resolve(found);
      }
    });

    obs.observe(document.body, { childList: true, subtree: true, attributes: true });
  });
}

/**
 * Wait for the page URL to change from `currentUrl`.
 * Uses popstate / hashchange events for SPA routing and a MutationObserver
 * for title changes as a fallback signal, rather than rAF polling.
 */
export function waitForNavigation(currentUrl: string, timeout = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    if (window.location.href !== currentUrl) {
      resolve(window.location.href);
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Navigation timeout'));
    }, timeout);

    function onNavigate() {
      if (window.location.href !== currentUrl) {
        cleanup();
        resolve(window.location.href);
      }
    }

    // SPA routing events
    window.addEventListener('popstate', onNavigate);
    window.addEventListener('hashchange', onNavigate);

    // Patch pushState/replaceState for SPA frameworks that don't fire popstate
    const origPush = history.pushState.bind(history);
    const origReplace = history.replaceState.bind(history);

    history.pushState = function (...args) {
      origPush(...args);
      onNavigate();
    };

    history.replaceState = function (...args) {
      origReplace(...args);
      onNavigate();
    };

    // Also watch title changes as a fallback signal for full-page navigations
    const titleObs = new MutationObserver(onNavigate);
    const titleEl = document.querySelector('title');
    if (titleEl) {
      titleObs.observe(titleEl, { childList: true, characterData: true });
    }

    function cleanup() {
      clearTimeout(timer);
      window.removeEventListener('popstate', onNavigate);
      window.removeEventListener('hashchange', onNavigate);
      history.pushState = origPush;
      history.replaceState = origReplace;
      titleObs.disconnect();
    }
  });
}

// ---------------------------------------------------------------------------
// Network idle tracking — intercept fetch/XHR to know when API calls settle
// ---------------------------------------------------------------------------
let _pendingRequests = 0;
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
    _pendingRequests++;
    const url = typeof args[0] === 'string' ? args[0] : (args[0] as Request)?.url ?? '';
    const isCritical = !isAnalyticsRequest(url);
    if (isCritical) _pendingCritical++;
    return originalFetch.apply(this, args).finally(() => {
      _pendingRequests--;
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
      _pendingRequests++;
      const isCritical = !isAnalyticsRequest(this.__pathfinder_url ?? '');
      if (isCritical) _pendingCritical++;
      this.addEventListener('loadend', () => {
        _pendingRequests--;
        if (isCritical) _pendingCritical--;
      }, { once: true });
    }
    return origSend.apply(this, args as any);
  };
}

/**
 * Check if the network is idle. By default, only considers critical requests
 * (API calls), ignoring analytics/tracking requests that may never complete.
 */
export function isNetworkIdle(): boolean {
  return _pendingCritical === 0;
}

export function getPendingRequestCount(): number {
  return _pendingCritical;
}

/** Total pending requests including analytics (for debugging). */
export function getTotalPendingRequestCount(): number {
  return _pendingRequests;
}

/**
 * Wait for all in-flight fetch/XHR requests to complete, OR timeout.
 */
export function waitForNetworkIdle(timeout = 5000): Promise<void> {
  return new Promise((resolve) => {
    if (_pendingRequests === 0) { resolve(); return; }

    const maxTimer = setTimeout(resolve, timeout);
    const interval = setInterval(() => {
      if (_pendingRequests === 0) {
        clearInterval(interval);
        clearTimeout(maxTimer);
        resolve();
      }
    }, 100);
  });
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
      // If network requests are still in flight, wait using remaining time budget
      if (_pendingRequests > 0) {
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
          if (_pendingRequests === 0) {
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
