/**
 * Chrome DevTools Protocol (CDP) client for the pathfinder extension.
 *
 * Uses chrome.debugger API to attach to a tab and send CDP commands.
 * Provides trusted input dispatch, accessibility tree queries,
 * network HAR capture, full-page screenshots, and JS dialog handling.
 *
 * IMPORTANT: Only one debugger session can be attached to a tab at a time.
 * Call attach() before using any CDP method, and detach() when done.
 */
import { createLogger } from '../../utils/logger';

const log = createLogger('cdp-client');

// ── Session Management ──────────────────────────────────────────────────────

const attachedTabs = new Set<number>();

export async function attach(tabId: number): Promise<void> {
  if (attachedTabs.has(tabId)) return;

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attachedTabs.add(tabId);
    log.info(`CDP attached to tab ${tabId}`);
  } catch (err) {
    // Already attached (another extension or DevTools open)
    if (String(err).includes('Another debugger is already attached')) {
      log.warn(`Tab ${tabId} already has a debugger attached`);
      return;
    }
    throw err;
  }
}

export async function detach(tabId: number): Promise<void> {
  if (!attachedTabs.has(tabId)) return;

  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // Tab may already be closed
  }
  attachedTabs.delete(tabId);
  log.info(`CDP detached from tab ${tabId}`);
}

export function isAttached(tabId: number): boolean {
  return attachedTabs.has(tabId);
}

async function sendCommand<T = unknown>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
  if (!attachedTabs.has(tabId)) {
    await attach(tabId);
  }
  return chrome.debugger.sendCommand({ tabId }, method, params) as Promise<T>;
}

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
});

// Clean up when debugger is detached externally (user closes DevTools banner)
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) {
    attachedTabs.delete(source.tabId);
    log.info(`CDP detached externally from tab ${source.tabId}`);
  }
});

// ── Trusted Input Dispatch ──────────────────────────────────────────────────

/**
 * Dispatch a trusted mouse click via CDP Input.dispatchMouseEvent.
 * Unlike synthetic DOM events, these are indistinguishable from real user input.
 */
export async function dispatchClick(tabId: number, x: number, y: number): Promise<void> {
  await sendCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1,
  });
  await sendCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1,
  });
}

/** CDP modifier bitmask values (Input.dispatchKeyEvent `modifiers`). */
export const CDP_MODIFIERS = { Alt: 1, Ctrl: 2, Control: 2, Meta: 4, Cmd: 4, Command: 4, Shift: 8 } as const;

/**
 * Dispatch a trusted keyboard key press via CDP Input.dispatchKeyEvent.
 *
 * `modifiers` is the CDP modifier bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8).
 * The `char` event (which produces text input) is only fired for a bare
 * single character with no modifiers held — otherwise Ctrl+A would type "a".
 */
export async function dispatchKeyPress(tabId: number, key: string, text?: string, modifiers = 0): Promise<void> {
  const keyCode = key.length === 1 ? key.toUpperCase().charCodeAt(0) : KEY_CODES[key] ?? 0;
  const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;

  await sendCommand(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    modifiers,
    text: text ?? (key.length === 1 ? key : ''),
  });

  // Only emit the text-producing `char` event for an unmodified single char.
  if (key.length === 1 && modifiers === 0) {
    await sendCommand(tabId, 'Input.dispatchKeyEvent', {
      type: 'char',
      key,
      text: text ?? key,
      unmodifiedText: key,
    });
  }

  await sendCommand(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    modifiers,
  });
}

/** Press (keyDown only) a modifier key so subsequent keys are dispatched while it is held. */
export async function dispatchKeyDownRaw(tabId: number, key: string, modifiers = 0): Promise<void> {
  await sendCommand(tabId, 'Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key,
    code: key,
    modifiers,
  });
}

/** Release (keyUp only) a previously-held key. */
export async function dispatchKeyUpRaw(tabId: number, key: string, modifiers = 0): Promise<void> {
  await sendCommand(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code: key,
    modifiers,
  });
}

/**
 * Type a string character-by-character via CDP trusted key events.
 * Much more reliable than synthetic input events for React/Vue controlled inputs.
 */
export async function dispatchType(tabId: number, text: string): Promise<void> {
  for (const char of text) {
    await dispatchKeyPress(tabId, char, char);
    // Small delay between chars to let frameworks process
    await delay(20);
  }
}

/**
 * Dispatch trusted mouse hover (mouseMoved) event.
 */
export async function dispatchHover(tabId: number, x: number, y: number): Promise<void> {
  await sendCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
  });
}

// ── Accessibility Tree ──────────────────────────────────────────────────────

export interface AXNode {
  nodeId: string;
  role: { type: string; value: string };
  name?: { type: string; value: string };
  description?: { type: string; value: string };
  value?: { type: string; value: string };
  properties?: Array<{ name: string; value: { type: string; value: unknown } }>;
  children?: AXNode[];
}

/**
 * Fetch the full accessibility tree for a tab.
 * Returns a simplified, serializable tree that can be passed to AI as context.
 */
export async function getAccessibilityTree(tabId: number): Promise<AXNode[]> {
  try {
    await sendCommand(tabId, 'Accessibility.enable');
    const result = await sendCommand<{ nodes: AXNode[] }>(tabId, 'Accessibility.getFullAXTree', {
      depth: 10,
    });
    return result.nodes ?? [];
  } catch (err) {
    log.warn('Failed to get accessibility tree', err);
    return [];
  }
}

/**
 * Serialize the accessibility tree into a compact text representation
 * suitable for LLM context. Much cleaner than raw DOM.
 */
export function serializeAXTree(nodes: AXNode[], maxDepth = 6): string {
  if (nodes.length === 0) return 'No accessibility tree available.';

  const lines: string[] = [];
  const rootNodes = buildAXHierarchy(nodes);

  function walk(node: AXNode, depth: number) {
    if (depth > maxDepth) return;

    const role = node.role?.value ?? 'unknown';
    const name = node.name?.value ?? '';
    const value = node.value?.value ?? '';

    // Skip ignored/generic nodes
    if (role === 'none' || role === 'generic' || role === 'InlineTextBox') return;

    const indent = '  '.repeat(depth);
    let line = `${indent}[${role}]`;
    if (name) line += ` "${name}"`;
    if (value) line += ` value="${value}"`;

    // Add key properties
    const props = node.properties ?? [];
    const disabled = props.find((p) => p.name === 'disabled');
    const required = props.find((p) => p.name === 'required');
    const checked = props.find((p) => p.name === 'checked');
    const expanded = props.find((p) => p.name === 'expanded');

    if (disabled?.value?.value) line += ' (disabled)';
    if (required?.value?.value) line += ' (required)';
    if (checked?.value?.value === 'true') line += ' (checked)';
    if (expanded?.value?.value === 'true') line += ' (expanded)';

    lines.push(line);

    if (node.children) {
      for (const child of node.children) {
        walk(child, depth + 1);
      }
    }
  }

  for (const root of rootNodes) {
    walk(root, 0);
  }

  const result = lines.join('\n');
  // Cap at ~8000 chars to stay within token budget
  return result.length > 8000 ? result.slice(0, 8000) + '\n... (truncated)' : result;
}

function buildAXHierarchy(flatNodes: AXNode[]): AXNode[] {
  // CDP returns a flat list — nodes reference children by index.
  // If children are already nested, return as-is.
  if (flatNodes.length > 0 && flatNodes[0].children) {
    return flatNodes.filter((_, i) => i === 0);
  }
  // Otherwise return top-level nodes only
  return flatNodes.slice(0, 1);
}

// ── JavaScript Dialog Handling ──────────────────────────────────────────────

/**
 * Enable auto-dismissal of JavaScript dialogs (alert, confirm, prompt).
 * Much more reliable than monkey-patching window.alert in content script.
 */
export async function enableDialogAutoDismiss(tabId: number): Promise<void> {
  await sendCommand(tabId, 'Page.enable');

  // The event listener is set up via chrome.debugger.onEvent
  // We handle it in the global event listener below
}

// Global CDP event handler for dialog auto-dismiss
const dialogHandlerTabs = new Set<number>();

export function registerDialogHandler(tabId: number): void {
  dialogHandlerTabs.add(tabId);
}

export function unregisterDialogHandler(tabId: number): void {
  dialogHandlerTabs.delete(tabId);
}

chrome.debugger.onEvent.addListener((source, method) => {
  if (method === 'Page.javascriptDialogOpening' && source.tabId !== undefined) {
    if (dialogHandlerTabs.has(source.tabId)) {
      // Auto-accept the dialog
      chrome.debugger.sendCommand(
        { tabId: source.tabId },
        'Page.handleJavaScriptDialog',
        { accept: true }
      ).catch((err) => log.warn('Failed to dismiss dialog', err));
    }
  }
});

// ── Full-Page Screenshots via CDP ───────────────────────────────────────────

/**
 * Capture a full-page screenshot (including content below the fold).
 * Returns a base64-encoded PNG data URL.
 */
export async function captureFullPageScreenshot(tabId: number): Promise<string | undefined> {
  try {
    const { data } = await sendCommand<{ data: string }>(tabId, 'Page.captureScreenshot', {
      format: 'png',
      quality: 80,
      captureBeyondViewport: true,
      fromSurface: true,
    });
    return `data:image/png;base64,${data}`;
  } catch (err) {
    log.warn('CDP screenshot failed', err);
    return undefined;
  }
}

// ── Network HAR Capture ─────────────────────────────────────────────────────

export interface HAREntry {
  url: string;
  method: string;
  status: number;
  statusText: string;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  mimeType: string;
  startedAt: number;
  duration: number;
  bodySize: number;
  requestBody?: string;
}

const harBuffers = new Map<number, HAREntry[]>();
const pendingRequests = new Map<string, { tabId: number; url: string; method: string; headers: Record<string, string>; startedAt: number; body?: string }>();

/**
 * Start capturing network requests for a tab via CDP Network domain.
 */
export async function startHARCapture(tabId: number): Promise<void> {
  harBuffers.set(tabId, []);

  await sendCommand(tabId, 'Network.enable', {
    maxPostDataSize: 10240, // Capture request bodies up to 10KB
  });
}

/**
 * Stop capturing and return all captured HAR entries.
 */
export async function stopHARCapture(tabId: number): Promise<HAREntry[]> {
  const entries = harBuffers.get(tabId) ?? [];
  harBuffers.delete(tabId);

  // Clean up pending requests for this tab
  for (const [key, req] of pendingRequests.entries()) {
    if (req.tabId === tabId) pendingRequests.delete(key);
  }

  try {
    await sendCommand(tabId, 'Network.disable');
  } catch {
    // Tab may be closed
  }

  return entries;
}

/**
 * Get current HAR entries without stopping capture.
 */
export function getHAREntries(tabId: number): HAREntry[] {
  return harBuffers.get(tabId) ?? [];
}

/**
 * Number of network requests currently in-flight for a tab (issued but not yet
 * completed/failed). Zero means the network is momentarily quiet. Requires an
 * active HAR capture (Network domain enabled) for this tab — returns 0 otherwise.
 */
export function getPendingRequestCount(tabId: number): number {
  if (!harBuffers.has(tabId)) return 0;
  let count = 0;
  for (const req of pendingRequests.values()) {
    if (req.tabId === tabId) count++;
  }
  return count;
}

/**
 * Wait until the tab's network has been quiet (zero in-flight requests) for a
 * continuous `idleMs` window, or until `timeoutMs` elapses — whichever comes
 * first. This replaces fixed post-navigation/post-click sleeps: fast pages
 * proceed as soon as their requests settle, and slow SPAs get the time they
 * actually need (up to the ceiling).
 *
 * Requires an active HAR capture for the tab. Callers must fall back to a fixed
 * delay when CDP is unavailable — this resolves immediately (idle by
 * definition) if the Network domain isn't enabled for the tab.
 */
export async function waitForNetworkIdle(
  tabId: number,
  { idleMs = 500, timeoutMs = 10_000, pollMs = 100 }: { idleMs?: number; timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const start = Date.now();
  let quietSince: number | null = getPendingRequestCount(tabId) === 0 ? start : null;

  while (Date.now() - start < timeoutMs) {
    const pending = getPendingRequestCount(tabId);
    if (pending === 0) {
      if (quietSince === null) quietSince = Date.now();
      if (Date.now() - quietSince >= idleMs) return;
    } else {
      quietSince = null;
    }
    await delay(pollMs);
  }
  log.debug(`waitForNetworkIdle: timed out after ${timeoutMs}ms on tab ${tabId} (${getPendingRequestCount(tabId)} still pending)`);
}

/**
 * Wait for the document to reach a settled state — `readyState === 'complete'`
 * and no pending microtask-scheduled DOM mutations. Cheap CDP eval; best-effort.
 */
export async function waitForDomSettle(tabId: number, timeoutMs = 3_000): Promise<void> {
  try {
    await evaluate<boolean>(tabId, `
      (async () => {
        const deadline = Date.now() + ${timeoutMs};
        while (document.readyState !== 'complete' && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
        }
        // One rAF settle so freshly-committed DOM/layout is observable.
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        return true;
      })()
    `);
  } catch {
    /* non-fatal — settle is best-effort */
  }
}

// Minimal shapes for the CDP Network events we consume.
interface CDPRequestParams {
  requestId?: string;
  timestamp?: number;
  request?: { url?: string; method?: string; headers?: Record<string, string>; postData?: string };
  response?: {
    status?: number;
    statusText?: string;
    headers?: Record<string, string>;
    mimeType?: string;
    timing?: unknown;
    encodedDataLength?: number;
  };
}

// Handle CDP network events
chrome.debugger.onEvent.addListener((source, method, rawParams) => {
  const tabId = source.tabId;
  if (tabId === undefined || !harBuffers.has(tabId)) return;

  const params = (rawParams ?? {}) as CDPRequestParams;

  if (method === 'Network.requestWillBeSent') {
    const requestId = params.requestId ?? '';
    pendingRequests.set(requestId, {
      tabId,
      url: params.request?.url ?? '',
      method: params.request?.method ?? 'GET',
      headers: params.request?.headers ?? {},
      startedAt: params.timestamp ? params.timestamp * 1000 : Date.now(),
      body: params.request?.postData,
    });
  }

  if (method === 'Network.responseReceived') {
    const requestId = params.requestId ?? '';
    const pending = pendingRequests.get(requestId);
    if (!pending || pending.tabId !== tabId) return;

    const response = params.response ?? {};
    const entry: HAREntry = {
      url: pending.url,
      method: pending.method,
      status: response.status ?? 0,
      statusText: response.statusText ?? '',
      requestHeaders: pending.headers,
      responseHeaders: response.headers ?? {},
      mimeType: response.mimeType ?? '',
      startedAt: pending.startedAt,
      duration: response.timing && params.timestamp
        ? (params.timestamp * 1000) - pending.startedAt
        : 0,
      bodySize: response.encodedDataLength ?? 0,
      requestBody: pending.body,
    };

    const buffer = harBuffers.get(tabId);
    if (buffer) {
      buffer.push(entry);
      // Cap at 500 entries to prevent memory bloat
      if (buffer.length > 500) buffer.shift();
    }

    pendingRequests.delete(requestId);
  }

  if (method === 'Network.loadingFailed') {
    params.requestId && pendingRequests.delete(params.requestId);
  }
});

// ── Evaluate JS in Page Context ─────────────────────────────────────────────

/**
 * Execute JavaScript in the page context via CDP Runtime.evaluate.
 * Returns the evaluated result as a serializable value.
 */
export async function evaluate<T = unknown>(tabId: number, expression: string): Promise<T> {
  const result = await sendCommand<{
    result: { type: string; value?: T; description?: string };
    exceptionDetails?: { text: string };
  }>(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });

  if (result.exceptionDetails) {
    throw new Error(`CDP eval error: ${result.exceptionDetails.text}`);
  }
  return result.result.value as T;
}

/**
 * A JS function literal that pierces shadow DOM boundaries when searching for
 * elements. `document.querySelector` only searches the main tree — this
 * recurses into open shadow roots to find web-component elements. Shared by
 * every CDP evaluate that needs to locate an element by selector, so the
 * action runner and bounds lookup stay consistent.
 *
 * Usage inside an expression: `${DEEP_QUERY_FN} const el = __deepQuery(document, sel);`
 */
export const DEEP_QUERY_FN = `
  function __deepQuery(root, sel) {
    try { const el = root.querySelector(sel); if (el) return el; } catch (e) { return null; }
    const all = root.querySelectorAll('*');
    for (const host of all) {
      if (host.shadowRoot) {
        const found = __deepQuery(host.shadowRoot, sel);
        if (found) return found;
      }
    }
    return null;
  }
`;

export interface ElementState {
  found: boolean;
  visible: boolean;
  enabled: boolean;
  rect: { x: number; y: number; width: number; height: number } | null;
}

/**
 * Inspect an element's actionability state (present, visible, enabled) and its
 * center-point bounds — piercing shadow DOM. Used by the actionability
 * auto-wait so we never dispatch a trusted click at an element that is hidden,
 * disabled, or off-screen.
 */
export async function getElementState(tabId: number, selector: string): Promise<ElementState> {
  const empty: ElementState = { found: false, visible: false, enabled: false, rect: null };
  try {
    const state = await evaluate<ElementState>(tabId, `
      (() => {
        ${DEEP_QUERY_FN}
        const el = __deepQuery(document, ${JSON.stringify(selector)});
        if (!el) return ${JSON.stringify(empty)};
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const visible = r.width > 0 && r.height > 0 &&
          style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
        const enabled = !el.disabled && el.getAttribute('aria-disabled') !== 'true';
        return { found: true, visible, enabled, rect: { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height } };
      })()
    `);
    return state ?? empty;
  } catch {
    return empty;
  }
}

/**
 * Get the bounding box of an element by selector via CDP (shadow-DOM aware).
 * Returns { x, y, width, height } in viewport coordinates, or null if not found.
 */
export async function getElementBounds(tabId: number, selector: string): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const state = await getElementState(tabId, selector);
  return state.found ? state.rect : null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const KEY_CODES: Record<string, number> = {
  Enter: 13,
  Tab: 9,
  Escape: 27,
  Backspace: 8,
  Delete: 46,
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  Space: 32,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
