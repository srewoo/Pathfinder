/**
 * CDP Driver (fix.md §2, §3, §7, §8).
 *
 * The one execution substrate. Trusted `Input.*` events for dispatch, page-side
 * `Runtime.evaluate` for analysis. No content-script round-trip, no synthetic
 * `dispatchEvent` — those were the source of the dual-path divergence §3
 * describes.
 *
 * This is also where §7's safety controls are installed, deliberately: a policy
 * enforced in the driver cannot be bypassed by a caller, a prompt, or a
 * hallucinated step.
 */
import type {
  ClickOptions,
  Driver,
  DriverCapabilities,
  DriverPageSnapshot,
  DriverWithCapabilities,
  ElementHandle,
  NetworkRequest,
  NetworkResponse,
  RequestVerdict,
  TypeOptions,
  WaitOptions,
} from '../core/driver';
import { DriverError, ElementNotFoundError } from '../core/driver';
import type { Locator } from '../core/locator';
import { bestTier, describeLocator } from '../core/locator';
import type { ElementSample } from '../core/actionability';
import {
  NotActionableError,
  centerOf,
  checksForAction,
  evaluateActionability,
} from '../core/actionability';
import {
  attach,
  detach,
  isAttached,
  dispatchClick,
  dispatchType,
  dispatchHover,
  dispatchKeyPress,
  dispatchKeyDownRaw,
  dispatchKeyUpRaw,
  evaluate,
  enableDialogAutoDismiss,
  registerDialogHandler,
  unregisterDialogHandler,
  captureFullPageScreenshot,
  getAccessibilityTree,
  serializeAXTree,
  CDP_MODIFIERS,
} from '../core/cdp/cdp-client';
import {
  countExpr,
  focusExpr,
  pageTextExpr,
  readExpr,
  resolveExpr,
  sampleExpr,
  scrollIntoViewExpr,
  selectNativeExpr,
  setCheckedExpr,
  setValueExpr,
} from './page-scripts';
import { createLogger } from '../utils/logger';

const log = createLogger('cdp-driver');

const DEFAULT_TIMEOUT_MS = 15_000;
const POLL_MS = 100;
const NAVIGATE_TIMEOUT_MS = 20_000;
const DOUBLE_CLICK_GAP_MS = 50;

interface ResolveResult {
  tier: 'testid' | 'semantic' | 'structural';
  ref: string;
  sample: ElementSample;
  css?: string;
}

export interface CdpDriverOptions {
  tabId: number;
  /** Called for every heal (resolution below preferredTier) — §5 forbids silence. */
  onHeal?: (event: { locator: Locator; from: string; to: string }) => void;
}

export function createCdpDriver(opts: CdpDriverOptions): DriverWithCapabilities {
  const { tabId } = opts;
  let requestCb: ((r: NetworkRequest) => RequestVerdict) | null = null;
  let responseCb: ((r: NetworkResponse) => void) | null = null;
  const responses: NetworkResponse[] = [];

  // ── Resolution ────────────────────────────────────────────────────────────

  async function resolveRaw(loc: Locator): Promise<ResolveResult | null> {
    try {
      return await evaluate<ResolveResult | null>(tabId, resolveExpr(loc));
    } catch (err) {
      log.debug(`resolve failed for ${describeLocator(loc)}`, err);
      return null;
    }
  }

  function toHandle(loc: Locator, r: ResolveResult): ElementHandle {
    const preferred = bestTier(loc);
    const healed = r.tier !== preferred;
    if (healed) {
      // Surfacing every heal is non-negotiable (§5): silent healing is how a
      // test keeps passing while asserting nothing.
      log.warn(`Locator healed: ${describeLocator(loc)} resolved at "${r.tier}" (preferred "${preferred}")`);
      opts.onHeal?.({ locator: loc, from: preferred, to: r.tier });
    }
    return {
      ref: r.ref,
      locator: loc,
      tier: r.tier,
      healed,
      rect: r.sample.rect,
      resolvedCss: r.css,
    };
  }

  /**
   * The single wait primitive (§8). Resolves the locator and polls its
   * actionability until every required check passes, then returns the handle.
   */
  async function waitForAction(
    loc: Locator,
    action: string,
    o?: WaitOptions
  ): Promise<ElementHandle> {
    const timeoutMs = o?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const checks = o?.checks ?? checksForAction(action);
    const deadline = Date.now() + timeoutMs;

    let previous: ElementSample | null = null;
    let verdict = evaluateActionability(
      { attached: false, visible: false, enabled: false, rect: null, receivesEvents: false },
      null,
      checks
    );
    let handle: ElementHandle | null = null;
    let scrolled = false;

    for (;;) {
      const raw = await resolveRaw(loc);
      if (raw) {
        handle = toHandle(loc, raw);

        // Scroll into view once, before judging geometry — an element below the
        // fold is not "obscured", it is simply not yet on screen.
        if (!scrolled) {
          scrolled = true;
          await evaluate(tabId, scrollIntoViewExpr(raw.ref)).catch(() => undefined);
          previous = null;
          await delay(POLL_MS);
          continue;
        }

        const current = raw.sample;
        verdict = evaluateActionability(current, previous, checks);
        if (verdict.actionable) {
          return { ...handle, rect: current.rect };
        }
        previous = current;
      } else {
        previous = null;
        scrolled = false;
      }

      if (Date.now() >= deadline) {
        if (!handle) throw new ElementNotFoundError(describeLocator(loc));
        throw new NotActionableError(describeLocator(loc), verdict, timeoutMs);
      }
      await delay(POLL_MS);
    }
  }

  async function clickPoint(handle: ElementHandle): Promise<{ x: number; y: number }> {
    // Re-sample immediately before dispatch: the deadline may have been met a
    // poll ago and layout can shift in between.
    const fresh = await evaluate<ElementSample>(tabId, sampleExpr(handle.ref)).catch(() => null);
    const rect = fresh?.rect ?? handle.rect;
    if (!rect) throw new DriverError(`No geometry for ${describeLocator(handle.locator)}`);
    if (fresh?.proxiedBy) {
      // The rect is the proxy's, so this dispatches on the label rather than on
      // the hidden control it owns. Logged because the distinction matters when
      // reading a run: the click was on something else, by design.
      log.debug(
        `Clicking ${describeLocator(handle.locator)} via its label (${fresh.proxiedBy}) — ` +
          `the control itself is not hit-testable.`
      );
    }
    return centerOf(rect);
  }

  // ── Driver ────────────────────────────────────────────────────────────────

  const driver: DriverWithCapabilities = {
    async open() {
      if (!isAttached(tabId)) await attach(tabId);
      registerDialogHandler(tabId);
    },

    async close() {
      unregisterDialogHandler(tabId);
      try {
        await detach(tabId);
      } catch {
        // Tab may already be gone — closing must be safe to call twice.
      }
    },

    async navigate(url) {
      if (!url) throw new DriverError('navigate requires a URL');
      await navigateTab(tabId, url);
    },

    async currentUrl() {
      return evaluate<string>(tabId, 'location.href');
    },

    async snapshot(): Promise<DriverPageSnapshot> {
      const [url, title, text] = await Promise.all([
        evaluate<string>(tabId, 'location.href').catch(() => ''),
        evaluate<string>(tabId, 'document.title').catch(() => ''),
        evaluate<string>(tabId, pageTextExpr()).catch(() => ''),
      ]);
      let axTree: string | undefined;
      try {
        axTree = serializeAXTree(await getAccessibilityTree(tabId));
      } catch {
        axTree = undefined;
      }
      return { url, title, text, axTree };
    },

    async resolve(loc) {
      const raw = await resolveRaw(loc);
      return raw ? toHandle(loc, raw) : null;
    },

    async sample(handle) {
      const s = await evaluate<ElementSample>(tabId, sampleExpr(handle.ref));
      return (
        s ?? { attached: false, visible: false, enabled: false, rect: null, receivesEvents: false }
      );
    },

    async waitFor(loc, o) {
      return waitForAction(loc, 'click', o);
    },

    async click(loc, o?: ClickOptions) {
      const action = o?.double ? 'double_click' : 'click';
      const handle = await waitForAction(loc, action, o);
      const pt = await clickPoint(handle);
      await dispatchClick(tabId, pt.x, pt.y);
      if (o?.double) {
        await delay(DOUBLE_CLICK_GAP_MS);
        await dispatchClick(tabId, pt.x, pt.y);
      }
      return handle;
    },

    async type(loc, text, o?: TypeOptions) {
      const handle = await waitForAction(loc, 'type', o);

      const focused = await evaluate<boolean>(tabId, focusExpr(handle.ref)).catch(() => false);
      if (!focused) {
        // Click to focus as a fallback — some frameworks only wire focus on
        // pointer interaction.
        const pt = await clickPoint(handle);
        await dispatchClick(tabId, pt.x, pt.y);
      }

      if (o?.clear !== false) {
        await evaluate(tabId, setValueExpr(handle.ref, ''));
      }

      await dispatchType(tabId, text);

      if (o?.verify !== false && text) {
        const landed = await evaluate<string | null>(tabId, readExpr(handle.ref, 'value')).catch(
          () => null
        );
        if (typeof landed === 'string' && !landed.includes(text)) {
          // A type that leaves the field unchanged is a real failure, not a pass.
          throw new DriverError(
            `Typed value did not land in ${describeLocator(loc)} — field reads "${landed.slice(0, 40)}"`
          );
        }
      }
      return handle;
    },

    async clear(loc, o) {
      const handle = await waitForAction(loc, 'clear', o);
      const ok = await evaluate<boolean>(tabId, setValueExpr(handle.ref, ''));
      if (!ok) throw new DriverError(`Could not clear ${describeLocator(loc)}`);
      return handle;
    },

    async hover(loc, o) {
      const handle = await waitForAction(loc, 'hover', o);
      const pt = await clickPoint(handle);
      await dispatchHover(tabId, pt.x, pt.y);
      return handle;
    },

    async setChecked(loc, checked, o) {
      const handle = await waitForAction(loc, checked ? 'check' : 'uncheck', o);
      // Prefer a real click — it exercises the app's own handler. Verify after,
      // and only fall back to the native setter if the state did not change.
      const pt = await clickPoint(handle);
      await dispatchClick(tabId, pt.x, pt.y);

      const now = await evaluate<string | null>(tabId, readExpr(handle.ref, 'attribute', 'checked'));
      const viaClick = (now !== null) === checked;
      if (!viaClick) {
        const ok = await evaluate<boolean | null>(tabId, setCheckedExpr(handle.ref, checked));
        if (ok !== true) {
          throw new DriverError(
            `Could not set ${describeLocator(loc)} to checked=${checked}`
          );
        }
      }
      return handle;
    },

    async selectOption(loc, value, o) {
      const handle = await waitForAction(loc, 'select', o);

      const native = await evaluate<{ ok: boolean; reason?: string } | null>(
        tabId,
        selectNativeExpr(handle.ref, value)
      );
      if (native !== null) {
        if (!native.ok) throw new DriverError(`select failed: ${native.reason}`);
        return handle;
      }

      // Custom dropdown: open it, then click the option by its accessible name.
      // Ported from the former dom-actions custom-dropdown handling.
      const pt = await clickPoint(handle);
      await dispatchClick(tabId, pt.x, pt.y);
      await delay(200);

      const optionLoc: Locator = {
        semantic: { role: 'option', name: value },
        structural: {
          css: `[role="option"], li[data-value="${value}"], .option, .MuiMenuItem-root`,
        },
        preferredTier: 'semantic',
        label: `option("${value}")`,
      };
      await driver.click(optionLoc, { timeoutMs: o?.timeoutMs ?? 5_000 });
      return handle;
    },

    async pressKey(key, loc, o) {
      if (loc) {
        const handle = await waitForAction(loc, 'press_key', o);
        await evaluate(tabId, focusExpr(handle.ref)).catch(() => undefined);
      }

      const parts = key.split('+');
      const mainKey = parts.pop() ?? key;
      const held: string[] = [];
      let mask = 0;
      for (const mod of parts) {
        const m = mod.toLowerCase();
        if (m === 'ctrl' || m === 'control') { held.push('Control'); mask |= CDP_MODIFIERS.Control; }
        else if (m === 'shift') { held.push('Shift'); mask |= CDP_MODIFIERS.Shift; }
        else if (m === 'alt') { held.push('Alt'); mask |= CDP_MODIFIERS.Alt; }
        else if (m === 'meta' || m === 'cmd' || m === 'command') { held.push('Meta'); mask |= CDP_MODIFIERS.Meta; }
      }

      for (const h of held) await dispatchKeyDownRaw(tabId, h, mask);
      try {
        await dispatchKeyPress(tabId, mainKey, undefined, mask);
      } finally {
        // Release in reverse regardless of outcome so modifiers never stick.
        for (const h of [...held].reverse()) await dispatchKeyUpRaw(tabId, h, 0);
      }
    },

    async dragDrop(from, to, o) {
      const src = await waitForAction(from, 'drag_drop', o);
      const dst = await waitForAction(to, 'drag_drop', o);
      const a = await clickPoint(src);
      const b = await clickPoint(dst);

      // Pointer-based drag via trusted events. Intermediate moves matter:
      // libraries with a drag threshold ignore a single jump.
      await dispatchHover(tabId, a.x, a.y);
      await dispatchMouse(tabId, 'mousePressed', a.x, a.y);
      const steps = 6;
      for (let i = 1; i <= steps; i++) {
        await dispatchMouse(
          tabId,
          'mouseMoved',
          a.x + ((b.x - a.x) * i) / steps,
          a.y + ((b.y - a.y) * i) / steps
        );
        await delay(16);
      }
      await dispatchMouse(tabId, 'mouseReleased', b.x, b.y);
    },

    async uploadFile(loc, fileNames, o) {
      const handle = await waitForAction(loc, 'upload_file', o);
      // DOM.setFileInputFiles is the only way to populate a file input; page
      // script cannot construct a trusted FileList.
      await sendRawCommand(tabId, 'DOM.setFileInputFiles', {
        files: fileNames,
        objectId: await resolveObjectId(tabId, handle.ref),
      });
      return handle;
    },

    async scroll(target) {
      if (target.locator) {
        const handle = await waitForAction(target.locator, 'scroll', {});
        await evaluate(tabId, scrollIntoViewExpr(handle.ref));
        return;
      }
      if (target.to === 'top') {
        await evaluate(tabId, 'window.scrollTo({ top: 0 })');
        return;
      }
      if (target.to === 'bottom') {
        await evaluate(tabId, 'window.scrollTo({ top: document.body.scrollHeight })');
        return;
      }
      await evaluate(tabId, `window.scrollBy({ top: ${Number(target.px ?? 0)} })`);
    },

    async readText(loc, o) {
      const handle = await waitForAction(loc, 'capture_value', o);
      return (await evaluate<string | null>(tabId, readExpr(handle.ref, 'text'))) ?? '';
    },

    async readValue(loc, o) {
      const handle = await waitForAction(loc, 'capture_value', o);
      return (await evaluate<string | null>(tabId, readExpr(handle.ref, 'value'))) ?? '';
    },

    async readAttribute(loc, attribute, o) {
      const handle = await waitForAction(loc, 'capture_value', o);
      return evaluate<string | null>(tabId, readExpr(handle.ref, 'attribute', attribute));
    },

    async count(loc) {
      return (await evaluate<number>(tabId, countExpr(loc))) ?? 0;
    },

    async evaluate<T>(expression: string): Promise<T> {
      return evaluate<T>(tabId, expression);
    },

    async screenshot() {
      return captureFullPageScreenshot(tabId);
    },

    onRequest(cb) {
      requestCb = cb;
    },
    onResponse(cb) {
      responseCb = cb;
    },
    networkLog() {
      return responses;
    },

    async autoDismissDialogs(enabled) {
      if (enabled) await enableDialogAutoDismiss(tabId);
    },

    capabilities(): DriverCapabilities {
      return {
        trustedInput: true,
        networkInterception: true,
        screenshots: true,
        accessibilityTree: true,
      };
    },
  };

  // Exposed so the interception wiring in cdp-safety can feed this driver.
  Object.defineProperty(driver, '__internal', {
    enumerable: false,
    value: {
      tabId,
      dispatchRequest: (r: NetworkRequest): RequestVerdict =>
        requestCb?.(r) ?? { action: 'continue' },
      dispatchResponse: (r: NetworkResponse) => {
        responses.push(r);
        responseCb?.(r);
      },
    },
  });

  return driver;
}

/** Access the interception hooks installed above. */
export function internalsOf(driver: Driver): {
  tabId: number;
  dispatchRequest: (r: NetworkRequest) => RequestVerdict;
  dispatchResponse: (r: NetworkResponse) => void;
} {
  const internal = (driver as unknown as Record<string, unknown>).__internal;
  if (!internal) throw new DriverError('Driver has no interception internals');
  return internal as ReturnType<typeof internalsOf>;
}

// ── Chrome-facing helpers ───────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function dispatchMouse(
  tabId: number,
  type: 'mousePressed' | 'mouseReleased' | 'mouseMoved',
  x: number,
  y: number
): Promise<void> {
  await sendRawCommand(tabId, 'Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: 'left',
    buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: type === 'mouseMoved' ? 0 : 1,
  });
}

async function sendRawCommand(tabId: number, method: string, params: object): Promise<unknown> {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

/** Resolve a `data-pf-ref` tagged node to a CDP objectId for DOM.* commands. */
async function resolveObjectId(tabId: number, ref: string): Promise<string> {
  const result = (await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `document.querySelector('[data-pf-ref="${ref}"]')`,
    returnByValue: false,
  })) as { result?: { objectId?: string } };
  const objectId = result?.result?.objectId;
  if (!objectId) throw new DriverError(`Could not obtain objectId for ref ${ref}`);
  return objectId;
}

/** Navigate and wait for load. Extracted so the driver owns navigation waits. */
function navigateTab(tabId: number, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new DriverError(`Navigation timeout after ${NAVIGATE_TIMEOUT_MS}ms: ${url}`));
    }, NAVIGATE_TIMEOUT_MS);

    const listener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId !== tabId || info.status !== 'complete') return;
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timeout);
      resolve();
    };

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url }).catch((err) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timeout);
      reject(err);
    });
  });
}
