/**
 * Record-and-Replay: Captures real user interactions on a page and converts
 * them into replayable test steps.
 *
 * Architecture:
 * - The service worker injects a recording script into the content script via messaging
 * - The content script captures DOM events (click, type, select, navigate, etc.)
 * - Events are buffered and sent back to the service worker as RecordedAction[]
 * - RecordedAction[] can be converted to ExecutionStep[] for replay
 */
import type { ExecutionStep } from '../../storage/schemas';

// ── Types ───────────────────────────────────────────────────────────────────

export interface RecordedAction {
  /** Timestamp of the event (ms since epoch) */
  timestamp: number;
  /** Type of user action */
  action: 'click' | 'type' | 'select' | 'check' | 'navigate' | 'scroll' | 'press_key' | 'hover';
  /** CSS selector for the target element */
  selector: string;
  /** Fallback selectors in priority order */
  fallbackSelectors?: string[];
  /** Value typed, selected, or entered */
  value?: string;
  /** Key pressed (for press_key actions) */
  key?: string;
  /** Human-readable description of the element */
  elementDescription: string;
  /** URL at the time of the event */
  url: string;
  /** For select: the option text chosen */
  optionText?: string;
}

export interface RecordingSession {
  id: string;
  startedAt: string;
  actions: RecordedAction[];
  startUrl: string;
}

// ── Recording Script (injected into content script) ─────────────────────────

/**
 * Returns the recording script source code that gets injected into the page.
 * This script captures user interactions and posts them back via window.postMessage.
 */
export function getRecordingScript(): string {
  return `
(function() {
  if (window.__pathfinder_recording) return;
  window.__pathfinder_recording = true;

  const actions = [];
  const MAX_ACTIONS = 500;

  // Build a reliable CSS selector for an element. When the element is inside
  // a shadow root, prefix the selector with a >> chain that the replay engine
  // can interpret as host-segments separated by " >> ".
  function buildSelector(el) {
    if (!el || el === document.body || el === document.documentElement) return 'body';

    // Detect shadow ancestry: walk up via getRootNode() at each level.
    const hostChain = [];
    let probe = el;
    while (probe) {
      const root = probe.getRootNode && probe.getRootNode();
      if (root && root.host && root !== probe.ownerDocument) {
        hostChain.unshift(root.host);
        probe = root.host;
      } else {
        break;
      }
    }
    if (hostChain.length > 0) {
      const segments = hostChain.map(buildSelectorWithin).concat(buildSelectorWithin(el));
      return segments.join(' >> ');
    }

    return buildSelectorWithin(el);
  }

  // Build a selector that uniquely identifies an element WITHIN its current
  // root (document or shadowRoot). Used for both top-level + shadow segments.
  function buildSelectorWithin(el) {
    if (!el || !el.tagName) return 'body';
    const root = (el.getRootNode && el.getRootNode()) || document;
    const queryAll = function(sel) {
      try { return root.querySelectorAll(sel); } catch (_) { return []; }
    };

    // Priority 1: data-testid
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test');
    if (testId) return '[data-testid="' + CSS.escape(testId) + '"]';

    // Priority 2: id
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
      return '#' + CSS.escape(el.id);
    }

    // Priority 3: aria-label
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) {
      const sel = el.tagName.toLowerCase() + '[aria-label="' + CSS.escape(ariaLabel) + '"]';
      if (document.querySelectorAll(sel).length === 1) return sel;
    }

    // Priority 4: name attribute for form elements
    const name = el.getAttribute('name');
    if (name) {
      const sel = el.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]';
      if (document.querySelectorAll(sel).length === 1) return sel;
    }

    // Priority 5: role + text
    const role = el.getAttribute('role');
    if (role) {
      const text = (el.textContent || '').trim().slice(0, 50);
      const sel = '[role="' + CSS.escape(role) + '"]';
      if (document.querySelectorAll(sel).length === 1) return sel;
    }

    // Priority 6: type + placeholder for inputs
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const type = el.getAttribute('type') || 'text';
      const placeholder = el.getAttribute('placeholder');
      if (placeholder) {
        const sel = el.tagName.toLowerCase() + '[placeholder="' + CSS.escape(placeholder) + '"]';
        if (document.querySelectorAll(sel).length === 1) return sel;
      }
    }

    // Priority 7: button type + text
    if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') {
      const text = (el.textContent || '').trim().slice(0, 40);
      if (text) {
        // Use class-based selector with text content for description
        const classes = Array.from(el.classList).filter(c => !c.match(/^(hover|focus|active|sm|md|lg|xl|2xl)/)).slice(0, 2).join('.');
        if (classes) {
          const sel = el.tagName.toLowerCase() + '.' + classes;
          if (document.querySelectorAll(sel).length === 1) return sel;
        }
      }
    }

    // Fallback: nth-of-type path
    const parts = [];
    let current = el;
    while (current && current !== document.body && parts.length < 4) {
      const tag = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(current) + 1;
          parts.unshift(tag + ':nth-of-type(' + idx + ')');
        } else {
          parts.unshift(tag);
        }
      } else {
        parts.unshift(tag);
      }
      current = parent;
    }
    return parts.join(' > ');
  }

  // Build multiple fallback selectors
  function buildFallbackSelectors(el) {
    const selectors = [];

    if (el.id) selectors.push('#' + CSS.escape(el.id));

    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test');
    if (testId) selectors.push('[data-testid="' + CSS.escape(testId) + '"]');

    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) selectors.push(el.tagName.toLowerCase() + '[aria-label="' + CSS.escape(ariaLabel) + '"]');

    const name = el.getAttribute('name');
    if (name) selectors.push(el.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]');

    const role = el.getAttribute('role');
    if (role) selectors.push('[role="' + CSS.escape(role) + '"]');

    return selectors.slice(0, 4);
  }

  // Describe an element in human-readable text
  function describeElement(el) {
    const tag = el.tagName.toLowerCase();
    const text = (el.textContent || '').trim().slice(0, 50);
    const label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '';
    const type = el.getAttribute('type') || '';

    if (tag === 'input' || tag === 'textarea') {
      return (label || type || tag) + ' field';
    }
    if (tag === 'button' || el.getAttribute('role') === 'button') {
      return '"' + (text || label || 'button') + '" button';
    }
    if (tag === 'a') {
      return '"' + (text || label || 'link') + '" link';
    }
    if (tag === 'select') {
      return (label || 'dropdown') + ' dropdown';
    }
    return text ? '"' + text + '" ' + tag : tag;
  }

  function record(action) {
    if (actions.length >= MAX_ACTIONS) return;
    actions.push(action);
    // Notify the content script about the new action
    window.postMessage({ type: '__pathfinder_RECORDED_ACTION', action: action }, '*');
  }

  // ── Click handler ──
  document.addEventListener('click', function(e) {
    const el = e.target;
    if (!el || !el.tagName) return;

    // Skip if this was a checkbox/radio (we handle those via change event)
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) return;

    record({
      timestamp: Date.now(),
      action: 'click',
      selector: buildSelector(el),
      fallbackSelectors: buildFallbackSelectors(el),
      elementDescription: describeElement(el),
      url: window.location.href,
    });
  }, true);

  // ── Input handler (type events) ──
  let inputDebounce = {};
  document.addEventListener('input', function(e) {
    const el = e.target;
    if (!el || !el.tagName) return;
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return;
    if (el.type === 'checkbox' || el.type === 'radio') return;

    const selector = buildSelector(el);

    // Debounce: only record final value after 500ms of inactivity
    clearTimeout(inputDebounce[selector]);
    inputDebounce[selector] = setTimeout(function() {
      record({
        timestamp: Date.now(),
        action: 'type',
        selector: selector,
        fallbackSelectors: buildFallbackSelectors(el),
        value: el.value,
        elementDescription: describeElement(el),
        url: window.location.href,
      });
    }, 500);
  }, true);

  // ── Change handler (select, checkbox, radio) ──
  document.addEventListener('change', function(e) {
    const el = e.target;
    if (!el || !el.tagName) return;

    if (el.tagName === 'SELECT') {
      const selectedOption = el.options[el.selectedIndex];
      record({
        timestamp: Date.now(),
        action: 'select',
        selector: buildSelector(el),
        fallbackSelectors: buildFallbackSelectors(el),
        value: el.value,
        optionText: selectedOption ? selectedOption.text.trim() : el.value,
        elementDescription: describeElement(el),
        url: window.location.href,
      });
      return;
    }

    if (el.type === 'checkbox' || el.type === 'radio') {
      record({
        timestamp: Date.now(),
        action: 'check',
        selector: buildSelector(el),
        fallbackSelectors: buildFallbackSelectors(el),
        value: el.checked ? 'true' : 'false',
        elementDescription: describeElement(el),
        url: window.location.href,
      });
      return;
    }
  }, true);

  // ── Keyboard handler (Enter, Escape, Tab) ──
  document.addEventListener('keydown', function(e) {
    if (['Enter', 'Escape', 'Tab'].includes(e.key)) {
      const el = e.target || document.activeElement;
      record({
        timestamp: Date.now(),
        action: 'press_key',
        selector: buildSelector(el),
        fallbackSelectors: buildFallbackSelectors(el),
        key: e.key,
        elementDescription: describeElement(el),
        url: window.location.href,
      });
    }
  }, true);

  // ── Navigation handler ──
  let lastUrl = window.location.href;
  const navObserver = new MutationObserver(function() {
    if (window.location.href !== lastUrl) {
      record({
        timestamp: Date.now(),
        action: 'navigate',
        selector: '',
        value: window.location.href,
        elementDescription: 'Navigation to ' + window.location.href,
        url: window.location.href,
      });
      lastUrl = window.location.href;
    }
  });
  navObserver.observe(document, { subtree: true, childList: true });

  window.addEventListener('popstate', function() {
    if (window.location.href !== lastUrl) {
      record({
        timestamp: Date.now(),
        action: 'navigate',
        selector: '',
        value: window.location.href,
        elementDescription: 'Navigation to ' + window.location.href,
        url: window.location.href,
      });
      lastUrl = window.location.href;
    }
  });

  // ── Network capture ──────────────────────────────────────────────────
  // Wrap fetch + XHR so the recording can be matched up against API calls
  // that the user's interaction triggered. Captured calls are exposed
  // alongside actions for replay-time stubbing.
  const networkCalls = [];
  const NET_BODY_LIMIT = 1500;
  function pushNetCall(c) {
    if (networkCalls.length >= 1000) return;
    networkCalls.push(c);
  }
  function truncate(s) {
    if (typeof s !== 'string') return undefined;
    return s.length > NET_BODY_LIMIT ? s.slice(0, NET_BODY_LIMIT - 1) + '…' : s;
  }

  if (typeof window.fetch === 'function') {
    const origFetch = window.fetch.bind(window);
    window.fetch = function(input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = (init && init.method) || (typeof input !== 'string' && input.method) || 'GET';
      const ts = Date.now();
      const reqBody = init && typeof init.body === 'string' ? truncate(init.body) : undefined;
      return origFetch(input, init).then(function(res) {
        try {
          pushNetCall({ url: String(url), method: String(method).toUpperCase(), status: res.status, requestBody: reqBody, timestamp: ts });
        } catch (_) { /* ignore */ }
        return res;
      });
    };
  }
  try {
    const OrigXHR = window.XMLHttpRequest;
    if (OrigXHR) {
      const origOpen = OrigXHR.prototype.open;
      const origSend = OrigXHR.prototype.send;
      OrigXHR.prototype.open = function(method, url) {
        this.__pathfinder_method = String(method || 'GET').toUpperCase();
        this.__pathfinder_url = String(url || '');
        this.__pathfinder_ts = Date.now();
        return origOpen.apply(this, arguments);
      };
      OrigXHR.prototype.send = function(body) {
        const xhr = this;
        const reqBody = typeof body === 'string' ? truncate(body) : undefined;
        xhr.addEventListener('loadend', function() {
          try {
            pushNetCall({ url: xhr.__pathfinder_url, method: xhr.__pathfinder_method, status: xhr.status, requestBody: reqBody, timestamp: xhr.__pathfinder_ts });
          } catch (_) { /* ignore */ }
        });
        return origSend.apply(this, arguments);
      };
    }
  } catch (_) { /* ignore — non-fatal */ }

  // ── Same-origin iframe traversal ─────────────────────────────────────
  // For every same-origin iframe, attach the same listeners. Cross-origin
  // frames are skipped silently — they can't be reached without breaking
  // the same-origin policy.
  function attachToFrames() {
    const frames = document.getElementsByTagName('iframe');
    for (let i = 0; i < frames.length; i++) {
      try {
        const doc = frames[i].contentDocument;
        if (!doc || doc.__pathfinder_attached) continue;
        doc.__pathfinder_attached = true;
        doc.addEventListener('click', function(e) {
          const el = e.target;
          if (!el || !el.tagName) return;
          record({
            timestamp: Date.now(),
            action: 'click',
            selector: buildSelector(el),
            fallbackSelectors: buildFallbackSelectors(el),
            elementDescription: '[iframe] ' + describeElement(el),
            url: window.location.href,
          });
        }, true);
      } catch (_) { /* cross-origin — skip */ }
    }
  }
  attachToFrames();
  // Re-attach when new frames appear
  const frameObserver = new MutationObserver(attachToFrames);
  frameObserver.observe(document.documentElement, { subtree: true, childList: true });

  // Expose getActions for retrieval
  window.__pathfinder_getRecordedActions = function() {
    return JSON.parse(JSON.stringify(actions));
  };

  // Expose recorded network calls
  window.__pathfinder_getRecordedNetwork = function() {
    return JSON.parse(JSON.stringify(networkCalls));
  };

  // Expose stopRecording
  window.__pathfinder_stopRecording = function() {
    window.__pathfinder_recording = false;
    navObserver.disconnect();
    frameObserver.disconnect();
    return {
      actions: JSON.parse(JSON.stringify(actions)),
      networkCalls: JSON.parse(JSON.stringify(networkCalls)),
    };
  };

  console.log('[pathfinder] Recording started');
})();
`;
}

// ── Convert recorded actions to ExecutionSteps ──────────────────────────────

/**
 * Convert raw recorded user actions into structured ExecutionStep[] that
 * can be executed by the test runner. Merges redundant actions and
 * cleans up noise.
 */
export function recordedActionsToSteps(actions: RecordedAction[]): ExecutionStep[] {
  const steps: ExecutionStep[] = [];
  let order = 1;

  // Remove duplicate consecutive clicks on the same element
  const deduped = deduplicateActions(actions);

  for (const action of deduped) {
    switch (action.action) {
      case 'click':
        steps.push({
          order: order++,
          action: 'click',
          selector: action.selector,
          description: `Click ${action.elementDescription}`,
        });
        break;

      case 'type':
        // Add clear before type to ensure clean state
        steps.push({
          order: order++,
          action: 'clear',
          selector: action.selector,
          description: `Clear ${action.elementDescription}`,
        });
        steps.push({
          order: order++,
          action: 'type',
          selector: action.selector,
          value: action.value ?? '',
          description: `Type "${action.value}" into ${action.elementDescription}`,
        });
        break;

      case 'select':
        steps.push({
          order: order++,
          action: 'select',
          selector: action.selector,
          value: action.optionText ?? action.value ?? '',
          description: `Select "${action.optionText ?? action.value}" from ${action.elementDescription}`,
        });
        break;

      case 'check':
        steps.push({
          order: order++,
          action: action.value === 'true' ? 'check' : 'uncheck',
          selector: action.selector,
          description: `${action.value === 'true' ? 'Check' : 'Uncheck'} ${action.elementDescription}`,
        });
        break;

      case 'navigate':
        if (action.value) {
          steps.push({
            order: order++,
            action: 'navigate',
            value: action.value,
            description: `Navigate to ${action.value}`,
          });
        }
        break;

      case 'press_key':
        steps.push({
          order: order++,
          action: 'press_key',
          selector: action.selector || undefined,
          key: action.key ?? 'Enter',
          description: `Press ${action.key} on ${action.elementDescription}`,
        });
        break;

      default:
        break;
    }
  }

  return steps;
}

/**
 * Remove redundant consecutive actions (e.g., multiple clicks on the same element,
 * multiple type events on the same field).
 */
function deduplicateActions(actions: RecordedAction[]): RecordedAction[] {
  const result: RecordedAction[] = [];

  for (let i = 0; i < actions.length; i++) {
    const current = actions[i];
    const prev = result[result.length - 1];

    // Skip consecutive type events on the same selector (keep the last one)
    if (current.action === 'type' && prev?.action === 'type' && prev.selector === current.selector) {
      result[result.length - 1] = current;
      continue;
    }

    // Skip consecutive clicks on the same element within 300ms
    if (current.action === 'click' && prev?.action === 'click' && prev.selector === current.selector) {
      if (current.timestamp - prev.timestamp < 300) continue;
    }

    // Skip navigation events that match the current URL of the next action
    if (current.action === 'navigate' && i + 1 < actions.length) {
      const next = actions[i + 1];
      if (next.url === current.value) continue;
    }

    result.push(current);
  }

  return result;
}

/**
 * Generate a human-readable test title from recorded actions.
 */
export function inferTestTitle(actions: RecordedAction[]): string {
  if (actions.length === 0) return 'Recorded test';

  const keyActions = actions.filter((a) => a.action !== 'navigate' && a.action !== 'scroll');
  if (keyActions.length === 0) return 'Navigate through pages';

  // Build title from first and last meaningful actions
  const first = keyActions[0];
  const last = keyActions[keyActions.length - 1];

  if (keyActions.length <= 2) {
    return first.elementDescription;
  }

  // Try to identify the workflow from actions
  const hasFormFill = keyActions.some((a) => a.action === 'type');
  const hasSubmit = keyActions.some((a) =>
    a.action === 'click' && (
      a.elementDescription.toLowerCase().includes('submit') ||
      a.elementDescription.toLowerCase().includes('save') ||
      a.elementDescription.toLowerCase().includes('create') ||
      a.elementDescription.toLowerCase().includes('send')
    )
  );

  if (hasFormFill && hasSubmit) {
    const submitAction = keyActions.find((a) =>
      a.action === 'click' && /submit|save|create|send|add|update/i.test(a.elementDescription)
    );
    return `Fill and submit form via ${submitAction?.elementDescription ?? 'button'}`;
  }

  return `User flow: ${first.elementDescription} → ${last.elementDescription}`;
}
