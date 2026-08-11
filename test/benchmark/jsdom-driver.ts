/**
 * jsdom-backed Driver for the benchmark (fix.md §10).
 *
 * Deliberately NOT a second fake: it evaluates the *same* injected page scripts
 * the CDP driver sends to a real browser (`page-scripts.ts`, `assert-scripts.ts`)
 * against a jsdom document. So the benchmark exercises the production locator
 * ladder, accessible-name computation, visibility rules and assertion semantics
 * — not a reimplementation that could agree with itself while both are wrong.
 *
 * What it cannot exercise: trusted input events, real layout, and CSS. jsdom
 * reports zero-size boxes, so geometry-dependent checks are relaxed here (see
 * `sample`). That limitation is recorded in the benchmark report rather than
 * hidden, because it means the harness cannot catch layout-caused flake.
 */
import type {
  ClickOptions,
  Driver,
  DriverPageSnapshot,
  ElementHandle,
  NetworkRequest,
  NetworkResponse,
  RequestVerdict,
  TypeOptions,
  WaitOptions,
} from '../../src/core/driver';
import { ElementNotFoundError } from '../../src/core/driver';
import type { Locator } from '../../src/core/locator';
import { bestTier, describeLocator } from '../../src/core/locator';
import type { ElementSample } from '../../src/core/actionability';
import {
  NotActionableError,
  checksForAction,
  evaluateActionability,
} from '../../src/core/actionability';
import {
  countExpr,
  readExpr,
  resolveExpr,
  sampleExpr,
  setCheckedExpr,
  setValueExpr,
} from '../../src/drivers/page-scripts';

interface ResolveResult {
  tier: 'testid' | 'semantic' | 'structural';
  ref: string;
  sample: ElementSample;
  css?: string;
}

export interface JsdomDriverOptions {
  /** Document to drive. Defaults to the ambient one. */
  doc?: Document;
  timeoutMs?: number;
}

export interface JsdomDriver extends Driver {
  /** Requests the "app" made, for network assertions. */
  requests(): NetworkResponse[];
  recordRequest(res: NetworkResponse): void;
  actionLog(): readonly string[];
}

export function createJsdomDriver(opts: JsdomDriverOptions = {}): JsdomDriver {
  const timeoutDefault = opts.timeoutMs ?? 300;
  const log: string[] = [];
  const responses: NetworkResponse[] = [];
  let requestCb: ((r: NetworkRequest) => RequestVerdict) | null = null;
  let responseCb: ((r: NetworkResponse) => void) | null = null;
  let url = 'https://fixture.test/';

  const doc = () => opts.doc ?? document;

  /**
   * Run an injected page script. This is the seam that makes the benchmark
   * faithful — `eval` here plays the role CDP's `Runtime.evaluate` plays in the
   * real driver, executing our own generated source.
   */
  function run<T>(expression: string): T {
    // eslint-disable-next-line no-eval
    return eval(expression) as T;
  }

  function resolveRaw(loc: Locator): ResolveResult | null {
    try {
      return run<ResolveResult | null>(resolveExpr(loc));
    } catch {
      return null;
    }
  }

  function nodeFor(ref: string): HTMLElement | null {
    return doc().querySelector(`[data-pf-ref="${ref}"]`) as HTMLElement | null;
  }

  /**
   * Relax geometry, because jsdom has no layout: every element reports a 0×0
   * box, which would fail `visible`, `stable` and `receivesEvents` for
   * everything. Presence + CSS-level hiding + `disabled` are still enforced, so
   * the checks that catch real defects still run.
   */
  function sampleOf(ref: string): ElementSample {
    const raw = run<ElementSample>(sampleExpr(ref));
    const el = nodeFor(ref);
    if (!el) return { attached: false, visible: false, enabled: false, rect: null, receivesEvents: false };

    const style = doc().defaultView?.getComputedStyle(el);
    const cssHidden =
      style?.display === 'none' || style?.visibility === 'hidden' || style?.opacity === '0';
    const hiddenAttr = el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true';

    return {
      attached: el.isConnected,
      visible: !cssHidden && !hiddenAttr,
      enabled: raw?.enabled ?? true,
      rect: { x: 0, y: 0, width: 10, height: 10 },
      receivesEvents: true,
    };
  }

  function toHandle(loc: Locator, r: ResolveResult): ElementHandle {
    return {
      ref: r.ref,
      locator: loc,
      tier: r.tier,
      healed: r.tier !== bestTier(loc),
      rect: { x: 0, y: 0, width: 10, height: 10 },
      resolvedCss: r.css,
    };
  }

  async function waitFor(loc: Locator, action: string, o?: WaitOptions): Promise<ElementHandle> {
    const checks = o?.checks ?? checksForAction(action);
    const deadline = Date.now() + (o?.timeoutMs ?? timeoutDefault);
    let previous: ElementSample | null = null;
    let verdict = evaluateActionability(
      { attached: false, visible: false, enabled: false, rect: null, receivesEvents: false },
      null,
      checks
    );

    for (;;) {
      const raw = resolveRaw(loc);
      if (raw) {
        const current = sampleOf(raw.ref);
        verdict = evaluateActionability(current, previous, checks);
        if (verdict.actionable) return toHandle(loc, raw);
        previous = current;
      } else {
        previous = null;
      }
      if (Date.now() >= deadline) {
        if (!raw) throw new ElementNotFoundError(describeLocator(loc));
        throw new NotActionableError(describeLocator(loc), verdict, o?.timeoutMs ?? timeoutDefault);
      }
      await tick();
    }
  }

  const driver: JsdomDriver = {
    async open() {},
    async close() {},

    async navigate(next) {
      url = next;
      log.push(`navigate ${next}`);
    },
    async currentUrl() {
      return url;
    },

    async snapshot(): Promise<DriverPageSnapshot> {
      return {
        url,
        title: doc().title,
        text: (doc().body?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      };
    },

    async resolve(loc) {
      const raw = resolveRaw(loc);
      return raw ? toHandle(loc, raw) : null;
    },

    async sample(handle) {
      return sampleOf(handle.ref);
    },

    async waitFor(loc, o) {
      return waitFor(loc, 'click', o);
    },

    async click(loc, o?: ClickOptions) {
      const h = await waitFor(loc, o?.double ? 'double_click' : 'click', o);
      const el = nodeFor(h.ref);
      if (!el) throw new ElementNotFoundError(describeLocator(loc));
      log.push(`click ${describeLocator(loc)}`);
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      if (o?.double) {
        el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      }
      await tick();
      return h;
    },

    async type(loc, text, o?: TypeOptions) {
      const h = await waitFor(loc, 'type', o);
      if (o?.clear !== false) run(setValueExpr(h.ref, ''));
      const el = nodeFor(h.ref) as HTMLInputElement | null;
      const existing = o?.clear === false ? (el?.value ?? '') : '';
      run(setValueExpr(h.ref, `${existing}${text}`));
      log.push(`type ${describeLocator(loc)} "${text}"`);
      await tick();
      return h;
    },

    async clear(loc, o) {
      const h = await waitFor(loc, 'clear', o);
      run(setValueExpr(h.ref, ''));
      return h;
    },

    async hover(loc, o) {
      return waitFor(loc, 'hover', o);
    },

    async setChecked(loc, checked, o) {
      const h = await waitFor(loc, checked ? 'check' : 'uncheck', o);
      run(setCheckedExpr(h.ref, checked));
      await tick();
      return h;
    },

    async selectOption(loc, value, o) {
      const h = await waitFor(loc, 'select', o);
      const el = nodeFor(h.ref) as HTMLSelectElement | null;
      if (!el) throw new ElementNotFoundError(describeLocator(loc));
      const opts = Array.from(el.options ?? []);
      const match = opts.find((x) => x.value === value || x.textContent?.trim() === value);
      if (!match) throw new Error(`Option "${value}" not present`);
      el.value = match.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      await tick();
      return h;
    },

    async pressKey(key, loc, o) {
      if (loc) await waitFor(loc, 'press_key', o);
      const target = (doc().activeElement ?? doc().body) as HTMLElement;
      target.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      );
      log.push(`pressKey ${key}`);
      await tick();
    },

    async dragDrop(from, to, o) {
      await waitFor(from, 'drag_drop', o);
      await waitFor(to, 'drag_drop', o);
    },

    async uploadFile(loc, files, o) {
      const h = await waitFor(loc, 'upload_file', o);
      run(setValueExpr(h.ref, files.join(',')));
      return h;
    },

    async scroll() {},

    async readText(loc, o) {
      const h = await waitFor(loc, 'capture_value', o);
      return run<string | null>(readExpr(h.ref, 'text')) ?? '';
    },

    async readValue(loc, o) {
      const h = await waitFor(loc, 'capture_value', o);
      return run<string | null>(readExpr(h.ref, 'value')) ?? '';
    },

    async readAttribute(loc, attribute, o) {
      const h = await waitFor(loc, 'capture_value', o);
      return run<string | null>(readExpr(h.ref, 'attribute', attribute));
    },

    async count(loc) {
      return run<number>(countExpr(loc)) ?? 0;
    },

    async evaluate<T>(expression: string): Promise<T> {
      return run<T>(expression);
    },

    async screenshot() {
      return undefined;
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
    async autoDismissDialogs() {},

    requests() {
      return responses;
    },
    recordRequest(res) {
      // Fixtures call this to simulate their own XHRs, so network assertions and
      // the mutation ledger have something real to read.
      void requestCb?.({ requestId: String(responses.length), url: res.url, method: res.method });
      responses.push(res);
      responseCb?.(res);
    },
    actionLog() {
      return log;
    },
  };

  return driver;
}

/** Let queued microtasks and 0ms timers flush — fixtures update state in them. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}
