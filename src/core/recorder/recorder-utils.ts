/**
 * Pure helpers for the recorder. These run in Node/JSDOM during tests and
 * also in-browser when stringified into the injected script via .toString().
 *
 * Keep them dependency-free and side-effect-free.
 */

import type { ExecutionStep } from '../../storage/schemas';
import type { RecordedAction } from './recorder';

// ─── Shadow DOM piercing ─────────────────────────────────────────────────────

/**
 * Build a selector path that pierces shadow roots. Returns a list of
 * selector segments — one per shadow boundary — because plain CSS cannot
 * cross shadow DOM boundaries. Replay code can chain `.shadowRoot.querySelector()`
 * for each segment.
 */
export interface PiercingSelector {
  /** Top-level selector applied to `document`. */
  root: string;
  /** Selectors to apply through successive shadowRoot boundaries. */
  shadowPath: string[];
}

/**
 * Walk up from `el` collecting host elements at every shadow boundary.
 * Returns the chain newest-first (closest host first).
 */
export function collectShadowHosts(el: Element): Element[] {
  const hosts: Element[] = [];
  let cur: Node | null = el;
  while (cur) {
    const root = (cur as Element).getRootNode?.();
    if (root && (root as ShadowRoot).host && (root as ShadowRoot) !== cur.ownerDocument) {
      const host = (root as ShadowRoot).host;
      hosts.push(host);
      cur = host;
    } else {
      break;
    }
  }
  return hosts;
}

// ─── Iframe traversal ────────────────────────────────────────────────────────

/**
 * Build a frame path from the top window down to `frame`. Each entry is the
 * selector or `name` attribute of the iframe element in the parent document.
 */
export function buildFramePath(frame: Window): string[] {
  const path: string[] = [];
  let cur: Window | null = frame;
  while (cur && cur.parent && cur !== cur.parent) {
    try {
      const frameEl = cur.frameElement as HTMLIFrameElement | null;
      if (!frameEl) break;
      const id = frameEl.id ? `#${frameEl.id}` : '';
      const name = frameEl.getAttribute('name');
      const segment = id || (name ? `iframe[name="${name}"]` : `iframe[src="${frameEl.src}"]`);
      path.unshift(segment);
      cur = cur.parent;
    } catch {
      // cross-origin parent — stop walking
      break;
    }
  }
  return path;
}

// ─── Network capture (record side) ───────────────────────────────────────────

export interface RecordedNetworkCall {
  url: string;
  method: string;
  status?: number;
  /** Truncated request body if textual. */
  requestBody?: string;
  /** Truncated response body if textual. */
  responseBody?: string;
  /** Wallclock ms when initiated. */
  timestamp: number;
  /** Which recorded action triggered this — empty if unknown. */
  triggeredBy?: string;
}

/**
 * Match recorded actions to network calls by timing proximity. Returns a
 * map of action-index → triggered network calls (within `windowMs`).
 */
export function correlateActionsAndNetwork(
  actions: RecordedAction[],
  network: RecordedNetworkCall[],
  windowMs = 1500,
): Map<number, RecordedNetworkCall[]> {
  const map = new Map<number, RecordedNetworkCall[]>();
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    const next = actions[i + 1];
    const upper = next ? next.timestamp : a.timestamp + windowMs;
    const calls = network.filter((n) => n.timestamp >= a.timestamp && n.timestamp < upper);
    if (calls.length > 0) map.set(i, calls);
  }
  return map;
}

// ─── Assertion suggestions ───────────────────────────────────────────────────

export interface AssertionSuggestion {
  /** Step order to insert this assertion AFTER. */
  afterOrder: number;
  step: ExecutionStep;
  /** Why this assertion was suggested — surfaced in the UI for confirmation. */
  reason: string;
}

/**
 * Inspect a list of recorded actions and propose assertions where a real user
 * would naturally verify something happened. Currently:
 *
 *  • After a click that immediately precedes a navigate → assert URL
 *  • After a type into a form field → assert the field has the value
 *  • After clicking a Save / Submit button → assert toast/success appears
 */
export function suggestAssertions(actions: RecordedAction[]): AssertionSuggestion[] {
  const out: AssertionSuggestion[] = [];

  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    const next = actions[i + 1];

    // 1. Click-then-navigate → URL assertion
    if (a.action === 'click' && next?.action === 'navigate' && next.value) {
      out.push({
        afterOrder: i + 1,
        step: {
          order: i + 1,
          action: 'assert',
          assertType: 'url',
          assertExpected: next.value,
          description: `Verify page navigated to ${next.value}`,
        },
        reason: 'Click triggered a navigation — assert the URL',
      });
    }

    // 2. Type → value-present assertion
    if (a.action === 'type' && a.value && a.value.length > 0) {
      out.push({
        afterOrder: i + 1,
        step: {
          order: i + 1,
          action: 'assert',
          assertType: 'value',
          selector: a.selector,
          assertExpected: a.value,
          description: `Verify ${a.elementDescription} contains "${a.value}"`,
        },
        reason: 'Form field was filled — assert the value persists',
      });
    }

    // 3. Submit/Save button click → toast/success assertion
    if (a.action === 'click' && /submit|save|create|update|confirm/i.test(a.elementDescription)) {
      out.push({
        afterOrder: i + 1,
        step: {
          order: i + 1,
          action: 'assert',
          assertType: 'visible',
          selector: '[role="alert"], [role="status"], .toast, .notification',
          description: 'Verify a success notification appears',
        },
        reason: 'Submit/Save click — assert a confirmation toast',
      });
    }
  }

  return out;
}

/**
 * Convert correlated network calls into network-stub steps. The replay
 * engine can use these to match real-time API requests against expected
 * shapes (URL + method) — surfaces silent backend regressions.
 */
export function networkCallsToStubSpec(calls: RecordedNetworkCall[]): Array<{
  url: string;
  method: string;
  status?: number;
}> {
  // Dedupe by url+method — multiple identical calls don't need multiple stubs.
  const seen = new Set<string>();
  const out: Array<{ url: string; method: string; status?: number }> = [];
  for (const c of calls) {
    const key = `${c.method} ${c.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url: c.url, method: c.method, status: c.status });
  }
  return out;
}
