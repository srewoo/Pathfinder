/**
 * A `Driver` backed by jsdom, with the fixture's own scripts executing.
 *
 * This is the deterministic tier of the evaluation harness. It is not a browser
 * and does not claim to be — but it is not a mock either: the fixture pages are
 * real HTML, their `<script>` blocks actually run, and the engine under test
 * (locator resolution, the healing cascade, assertion evaluation, verdict
 * computation) is the shipped code with nothing stubbed.
 *
 * That distinction is the whole point. Every seeded defect in the fixture lives
 * in script behaviour — a banner shown without a write, a response ignored,
 * validation skipped — so a DOM that does not execute scripts would measure
 * nothing at all: both variants would be identical static markup.
 *
 * ## What this tier CANNOT see, stated plainly
 *
 *  - **Layout.** jsdom computes none, so `getBoundingClientRect` is all zeros.
 *    Actionability is therefore read from attributes and inline styles
 *    (`hidden`, `display:none`, `visibility`, `disabled`, `aria-disabled`), not
 *    from geometry. Occlusion and motion-stability cannot be evaluated at all,
 *    and are reported as satisfied rather than guessed at — a check this tier
 *    cannot make must not fail an otherwise-good test.
 *  - **Trusted input.** Actions dispatch synthetic events. A control that only
 *    responds to a real user gesture would behave differently in Chrome.
 *  - **The real network.** `fetch` is stubbed per scenario, so an API failure is
 *    simulated rather than observed.
 *  - **Anything CSS-dependent** — a control hidden by a stylesheet rule rather
 *    than an inline style reads as visible here.
 *
 * A finding that depends on any of the above belongs to the real-browser tier,
 * which is a separate command and separately reported.
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
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
import { describeLocator } from '../../src/core/locator';
import type { ElementSample } from '../../src/core/actionability';
import {
  NotActionableError,
  checksForAction,
  evaluateActionability,
} from '../../src/core/actionability';

/** A captured request, so a scenario can assert on what the page called. */
export interface RecordedRequest {
  url: string;
  method: string;
  status: number;
}

export interface JsdomDriverOptions {
  /** Maps a page path (e.g. `save.html`) to the file to load. */
  resolvePage: (path: string) => string;
  /** Response for a `fetch` the page makes. Default 200 `{}`. */
  respondTo?: (url: string, method: string) => { status: number; body?: unknown };
  /** Wall-clock budget for a single `waitFor`. Kept small — jsdom is fast. */
  defaultTimeoutMs?: number;
}

/**
 * Every check this tier can actually evaluate.
 *
 * `stable` and `receivesEvents` are absent because they need layout. They are
 * reported as satisfied in `sample()` rather than dropped from the check set,
 * so the engine's own logic runs unchanged — but nothing here can fail them.
 */
const UNOBSERVABLE_CHECKS = new Set(['stable', 'receivesEvents']);

/**
 * The stand-in box for an element this tier considers displayed.
 *
 * Identical for every element on purpose — see `sample()`. Anything that reads
 * meaning into these numbers is asking a question this tier cannot answer.
 */
const SYNTHETIC_RECT = { x: 0, y: 0, width: 100, height: 20 } as const;

export class JsdomDriver implements Driver {
  private dom: JSDOM | undefined;
  private url = '';
  private refCounter = 0;
  private readonly handles = new Map<string, Element>();
  private readonly requests: RecordedRequest[] = [];
  /**
   * Storage carried across navigations.
   *
   * Each navigation builds a fresh jsdom, which starts with empty storage even
   * for the same origin. Without this the multipage journey scenario could not
   * distinguish "the app failed to carry the value" from "the harness threw the
   * value away", which would make the measurement meaningless.
   */
  private readonly session = new Map<string, string>();
  private readonly local = new Map<string, string>();
  private requestHook: ((r: NetworkRequest) => RequestVerdict) | undefined;
  private responseHook: ((r: NetworkResponse) => void) | undefined;

  constructor(private readonly opts: JsdomDriverOptions) {}

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async open(): Promise<void> {
    /* Nothing to attach to; a page arrives via navigate(). */
  }

  async close(): Promise<void> {
    this.captureStorage();
    this.dom?.window.close();
    this.dom = undefined;
    this.handles.clear();
  }

  // ── Navigation ───────────────────────────────────────────────────────────

  async navigate(url: string): Promise<void> {
    const page = url.split('/').pop() ?? url;
    const html = readFileSync(this.opts.resolvePage(page), 'utf-8');

    // Before the window goes away, or anything it wrote is lost.
    this.captureStorage();
    this.dom?.window.close();
    this.handles.clear();
    this.refCounter = 0;

    const dom = new JSDOM(html, {
      url: `http://fixture.local/${page}`,
      // The seeded defects are all script behaviour. Without this the two
      // variants are identical markup and the evaluation measures nothing.
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      // Both of these MUST be in place before the page's scripts run, which
      // happens during construction. Doing it afterwards meant a page that read
      // storage at parse time — the second step of the journey scenario — saw
      // an empty store and reported the value as lost when it had been carried.
      beforeParse: (window: Record<string, unknown>) => {
        this.restoreStorageInto(window);
        this.installFetchInto(window);
      },
    });
    this.dom = dom;
    this.url = url;

    // Scripts run on construction, but a fixture may schedule work with
    // setTimeout. Give the microtask queue a turn so `DOMContentLoaded`
    // handlers have completed before the first action.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  async currentUrl(): Promise<string> {
    return this.url;
  }

  /**
   * Replay storage into the new window and mirror writes back out.
   *
   * jsdom gives each instance its own storage area, so a value written on page 1
   * is gone on page 2. Carrying it is what makes a multipage journey testable at
   * all — and it is the harness doing it, not the application, which is stated
   * here so nobody reads a passing journey as proof the app persisted anything
   * by itself.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private restoreStorageInto(window: any): void {
    for (const [area, backing] of [
      ['sessionStorage', this.session],
      ['localStorage', this.local],
    ] as const) {
      const storage = window[area] as Storage;
      for (const [key, value] of backing) storage.setItem(key, value);
    }
  }

  /**
   * Read the window's storage back into the carried maps.
   *
   * A pull after each action rather than intercepting `Storage.setItem`: how
   * jsdom implements that object is not something the harness should depend on,
   * and wrapping it silently did nothing — which showed up as a save that
   * appeared to persist nowhere.
   */
  private captureStorage(): void {
    if (!this.dom) return;
    for (const [area, backing] of [
      ['sessionStorage', this.session],
      ['localStorage', this.local],
    ] as const) {
      const storage = this.dom.window[area];
      backing.clear();
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key !== null) backing.set(key, storage.getItem(key) ?? '');
      }
    }
  }

  /** Record every request and answer it from the scenario's own responder. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private installFetchInto(window: any): void {
    const respond = this.opts.respondTo ?? (() => ({ status: 200, body: {} }));
    window.fetch = async (input: unknown, init?: { method?: string }) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const request: NetworkRequest = { requestId: `req-${this.requests.length}`, url, method };
      const verdict = this.requestHook?.(request);
      if (verdict?.action === 'abort') {
        // Observed and reported, but this tier does not pretend to enforce the
        // allowlist — see `onRequest`.
        throw new Error(
          `JsdomDriver: a request to ${url} was refused by the interceptor ` +
            `(${verdict.reason}), but this tier cannot enforce that boundary — ` +
            `run the scenario on the real-browser tier.`
        );
      }
      const { status, body } = respond(url, method);
      this.requests.push({ url, method, status });
      this.responseHook?.({ requestId: request.requestId, url, method, status });
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body ?? {},
        text: async () => JSON.stringify(body ?? {}),
      };
    };
  }

  /** Requests the page made, for a scenario that needs to assert on them. */
  recordedRequests(): readonly RecordedRequest[] {
    return this.requests;
  }

  /** Read storage directly, to check whether a save actually persisted. */
  storedValue(area: 'local' | 'session', key: string): string | undefined {
    this.captureStorage();
    return (area === 'local' ? this.local : this.session).get(key);
  }

  // ── Inspection ───────────────────────────────────────────────────────────

  private get document(): Document {
    if (!this.dom) throw new Error('JsdomDriver: navigate() before using the page');
    return this.dom.window.document as unknown as Document;
  }

  async snapshot(): Promise<DriverPageSnapshot> {
    const doc = this.document;
    return {
      url: this.url,
      title: doc.title,
      text: (doc.body?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 4000),
      html: doc.documentElement.outerHTML.slice(0, 20_000),
    };
  }

  /**
   * Resolve a locator down the tier ladder, in the same order the real driver
   * uses, so `healed` means the same thing here as it does in Chrome.
   */
  async resolve(locator: Locator): Promise<ElementHandle | null> {
    const doc = this.document;

    const byTestId = locator.testid
      ? doc.querySelector(`[data-testid="${cssEscape(locator.testid)}"]`)
      : null;
    if (byTestId) return this.handleFor(byTestId, locator, 'testid');

    const bySemantic = locator.semantic ? this.findByRoleAndName(doc, locator.semantic) : null;
    if (bySemantic) return this.handleFor(bySemantic, locator, 'semantic');

    const css = locator.structural?.css;
    if (css) {
      // Comma-separated fallbacks are tried left to right, as Playwright and
      // the real driver do — a healed selector is prepended to the original.
      for (const candidate of css.split(',').map((c) => c.trim()).filter(Boolean)) {
        let found: Element | null = null;
        try {
          found = doc.querySelector(candidate);
        } catch {
          // An invalid selector is a miss, not a crash — the same as in Chrome.
        }
        if (found) {
          const handle = this.handleFor(found, locator, 'structural');
          return { ...handle, resolvedCss: candidate };
        }
      }
    }
    return null;
  }

  private findByRoleAndName(
    doc: Document,
    semantic: NonNullable<Locator['semantic']>
  ): Element | null {
    const wanted = semantic.name.trim().toLowerCase();
    for (const el of [...doc.querySelectorAll('*')]) {
      if (impliedRole(el) !== semantic.role) continue;
      if (!wanted) return el;
      const name = accessibleName(el).toLowerCase();
      // `exact` defaults to true: a substring match would let "Save" find
      // "Save and close", which is a different control.
      const hit = semantic.exact === false ? name.includes(wanted) : name === wanted;
      if (hit) return el;
    }
    return null;
  }

  private handleFor(
    el: Element,
    locator: Locator,
    tier: 'testid' | 'semantic' | 'structural'
  ): ElementHandle {
    const ref = `jsdom-${++this.refCounter}`;
    this.handles.set(ref, el);
    const preferred = locator.preferredTier;
    const order = { testid: 0, semantic: 1, structural: 2 } as const;
    return {
      ref,
      locator,
      tier,
      // Same definition as the real driver: resolution fell below what the
      // locator asked for.
      healed: order[tier] > order[preferred],
      // No layout in jsdom. A zero rect is the honest answer, and callers that
      // need geometry belong to the real-browser tier.
      rect: null,
    };
  }

  /**
   * Actionability from the only evidence this tier has.
   *
   * The rect is SYNTHETIC. jsdom computes no layout, so a real
   * `getBoundingClientRect` is all zeros — and the shipped evaluator reads an
   * empty box as "not visible", which would make every element on every fixture
   * page unusable. Supplying a fixed box for an element that is displayed
   * according to its attributes answers the evaluator's actual question ("is
   * this element displayed") from the evidence available, instead of letting a
   * missing measurement masquerade as a negative answer.
   *
   * The box carries no geometric meaning: it is the same for every element, so
   * nothing about position, size, overlap or motion can be inferred from it.
   * That is why `stable` and `receivesEvents` are excluded from the check set
   * rather than answered from this rect.
   */
  async sample(handle: ElementHandle): Promise<ElementSample> {
    const el = this.handles.get(handle.ref);
    if (!el) {
      return { attached: false, visible: false, enabled: false, rect: null, receivesEvents: false };
    }

    const attached = el.isConnected;
    const visible = attached && isVisibleByAttributes(el);
    return {
      attached,
      visible,
      enabled: !isDisabled(el),
      rect: visible ? SYNTHETIC_RECT : null,
      // Cannot be hit-tested without layout. Reported as satisfied rather than
      // guessed: a check this tier cannot make must not fail a good test.
      receivesEvents: true,
    };
  }

  async waitFor(locator: Locator, opts: WaitOptions = {}): Promise<ElementHandle> {
    const timeoutMs = opts.timeoutMs ?? this.opts.defaultTimeoutMs ?? 1500;
    // The engine's own check set, minus what this tier cannot observe. Filtering
    // here rather than lying in `sample()` keeps the real evaluator in charge of
    // the decision.
    const checks = (opts.checks ?? checksForAction('click')).filter(
      (c) => !UNOBSERVABLE_CHECKS.has(c)
    );
    const started = Date.now();
    const deadline = started + timeoutMs;

    let previous: ElementSample | null = null;
    let verdict = { actionable: false, failed: [] as never[] };
    for (;;) {
      const handle = await this.resolve(locator);
      if (handle) {
        const sample = await this.sample(handle);
        // The shipped evaluator, not a parallel one — a second implementation of
        // actionability is exactly what this harness must not introduce.
        verdict = evaluateActionability(sample, previous, checks) as typeof verdict;
        previous = sample;
        if (verdict.actionable) return handle;
      }
      if (Date.now() >= deadline) {
        if (!handle) throw new ElementNotFoundError(describeLocator(locator));
        throw new NotActionableError(describeLocator(locator), verdict, Date.now() - started);
      }
      // A fixture may reveal content on a timer; let those fire.
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  async click(locator: Locator, opts: ClickOptions = {}): Promise<ElementHandle> {
    const handle = await this.waitFor(locator, { ...opts, checks: opts.checks ?? checksForAction('click') });
    const el = this.handles.get(handle.ref)!;
    this.dispatchClick(el);
    if (opts.double) this.dispatchClick(el);
    await this.settle();
    return handle;
  }

  private dispatchClick(el: Element): void {
    const win = this.dom!.window;
    // A real click on a submit button submits its form; jsdom dispatches the
    // event but does not, so the form submit is raised explicitly.
    el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    const form = (el as HTMLElement).closest?.('form');
    const type = el.getAttribute('type');
    if (form && (el.tagName === 'BUTTON' || el.tagName === 'INPUT') && (type === 'submit' || !type)) {
      form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    }
  }

  async type(locator: Locator, text: string, opts: TypeOptions = {}): Promise<ElementHandle> {
    const handle = await this.waitFor(locator, { ...opts, checks: opts.checks ?? checksForAction('type') });
    const el = this.handles.get(handle.ref) as HTMLInputElement;
    if (opts.clear !== false) el.value = '';
    el.value = `${el.value}${text}`;
    this.fireInput(el);
    await this.settle();
    if (opts.verify !== false && el.value !== text && opts.clear !== false) {
      throw new Error(`Typed value did not land on ${describeLocator(locator)}`);
    }
    return handle;
  }

  async clear(locator: Locator, opts: WaitOptions = {}): Promise<ElementHandle> {
    const handle = await this.waitFor(locator, opts);
    const el = this.handles.get(handle.ref) as HTMLInputElement;
    el.value = '';
    this.fireInput(el);
    return handle;
  }

  async hover(locator: Locator, opts: WaitOptions = {}): Promise<ElementHandle> {
    const handle = await this.waitFor(locator, opts);
    const el = this.handles.get(handle.ref)!;
    el.dispatchEvent(new this.dom!.window.MouseEvent('mouseover', { bubbles: true }));
    await this.settle();
    return handle;
  }

  async setChecked(locator: Locator, checked: boolean, opts: WaitOptions = {}): Promise<ElementHandle> {
    const handle = await this.waitFor(locator, opts);
    const el = this.handles.get(handle.ref) as HTMLInputElement;
    el.checked = checked;
    this.fireInput(el, 'change');
    await this.settle();
    return handle;
  }

  async selectOption(locator: Locator, value: string, opts: WaitOptions = {}): Promise<ElementHandle> {
    const handle = await this.waitFor(locator, opts);
    const el = this.handles.get(handle.ref) as HTMLSelectElement;
    el.value = value;
    this.fireInput(el, 'change');
    await this.settle();
    return handle;
  }

  async pressKey(key: string, locator?: Locator): Promise<void> {
    const win = this.dom!.window;
    const target = locator ? this.handles.get((await this.waitFor(locator)).ref)! : this.document.body;
    target.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true }));
    target.dispatchEvent(new win.KeyboardEvent('keyup', { key, bubbles: true }));
    await this.settle();
  }

  async dragDrop(): Promise<void> {
    // Drag needs pointer geometry, which this tier does not have. Refused
    // loudly: a silent no-op would make a drag scenario pass without dragging.
    throw new Error('JsdomDriver: dragDrop needs layout — use the real-browser tier');
  }

  async uploadFile(locator: Locator, fileNames: string[]): Promise<ElementHandle> {
    const handle = await this.waitFor(locator);
    const el = this.handles.get(handle.ref) as HTMLInputElement;
    el.setAttribute('data-uploaded', fileNames.join(','));
    this.fireInput(el, 'change');
    return handle;
  }

  async scroll(): Promise<void> {
    /* No viewport to scroll. Harmless, and nothing in a fixture depends on it. */
  }

  // ── Reading ──────────────────────────────────────────────────────────────

  async readText(locator: Locator, opts: WaitOptions = {}): Promise<string> {
    const handle = await this.waitFor(locator, { ...opts, checks: opts.checks ?? ['attached'] });
    return (this.handles.get(handle.ref)!.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  async readValue(locator: Locator, opts: WaitOptions = {}): Promise<string> {
    const handle = await this.waitFor(locator, { ...opts, checks: opts.checks ?? ['attached'] });
    return (this.handles.get(handle.ref) as HTMLInputElement).value ?? '';
  }

  async readAttribute(locator: Locator, name: string, opts: WaitOptions = {}): Promise<string | null> {
    const handle = await this.waitFor(locator, { ...opts, checks: opts.checks ?? ['attached'] });
    return this.handles.get(handle.ref)!.getAttribute(name);
  }

  async count(locator: Locator): Promise<number> {
    const doc = this.document;
    if (locator.testid) {
      return doc.querySelectorAll(`[data-testid="${cssEscape(locator.testid)}"]`).length;
    }
    const css = locator.structural?.css;
    if (css) {
      try {
        return doc.querySelectorAll(css).length;
      } catch {
        return 0;
      }
    }
    return (await this.resolve(locator)) ? 1 : 0;
  }

  // ── Network ──────────────────────────────────────────────────────────────

  networkLog(): readonly NetworkResponse[] {
    return this.requests.map((r, i) => ({
      requestId: `req-${i}`,
      url: r.url,
      method: r.method,
      status: r.status,
    }));
  }

  /**
   * `fetch` is already intercepted, so the hook is honoured for observation.
   *
   * An `abort` verdict is NOT enforced: the origin allowlist and method gate are
   * real safety boundaries, and a tier that accepted the callback while letting
   * requests through would let a scenario believe it was protected when it was
   * not. Refusing loudly is the safe direction.
   */
  onRequest(cb: (r: NetworkRequest) => RequestVerdict): void {
    this.requestHook = cb;
  }

  onResponse(cb: (r: NetworkResponse) => void): void {
    this.responseHook = cb;
  }

  /**
   * Script evaluation is genuinely available here — jsdom runs scripts — and it
   * is what lets a scenario check state the DOM does not show, such as whether a
   * save actually reached storage.
   */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.dom!.window as any).eval(expression) as T;
  }

  async screenshot(): Promise<string | undefined> {
    // No renderer. `undefined` is the honest answer and every caller already
    // treats a missing screenshot as "none available".
    return undefined;
  }

  async autoDismissDialogs(): Promise<void> {
    // jsdom's `confirm`/`alert` return undefined and never block, so there is
    // nothing to dismiss. Stated rather than silently accepted.
  }

  /** Let timers and microtasks the page scheduled actually run. */
  private async settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Whatever the page just wrote is now readable by the harness and carried
    // across the next navigation.
    this.captureStorage();
  }

  private fireInput(el: Element, type: 'input' | 'change' = 'input'): void {
    el.dispatchEvent(new this.dom!.window.Event(type, { bubbles: true }));
  }
}

// ── Attribute-based actionability ──────────────────────────────────────────

/**
 * Visibility from attributes and inline styles only.
 *
 * A stylesheet rule that hides an element is invisible to this tier — stated in
 * the class comment, and the reason a visibility finding belongs to the
 * real-browser tier.
 */
function isVisibleByAttributes(el: Element): boolean {
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (node.hasAttribute('hidden')) return false;
    if (node.getAttribute('aria-hidden') === 'true') return false;
    const style = (node as HTMLElement).style;
    if (style?.display === 'none' || style?.visibility === 'hidden') return false;
    if (style?.opacity === '0') return false;
  }
  return true;
}

function isDisabled(el: Element): boolean {
  if (el.hasAttribute('disabled')) return true;
  if (el.getAttribute('aria-disabled') === 'true') return true;
  return !!(el as HTMLElement).closest?.('fieldset[disabled]');
}

/** The subset of implied roles the fixtures use. */
function impliedRole(el: Element): string | undefined {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;
  switch (el.tagName) {
    case 'BUTTON':
      return 'button';
    case 'A':
      return el.hasAttribute('href') ? 'link' : undefined;
    case 'INPUT': {
      const type = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button') return 'button';
      return 'textbox';
    }
    case 'SELECT':
      return 'combobox';
    case 'TEXTAREA':
      return 'textbox';
    case 'H1':
    case 'H2':
    case 'H3':
      return 'heading';
    default:
      return undefined;
  }
}

/** Accessible name, in the order the fixtures need. */
function accessibleName(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria) return aria.trim();
  const labelled = el.getAttribute('aria-labelledby');
  if (labelled) {
    const target = el.ownerDocument?.getElementById(labelled);
    if (target) return (target.textContent ?? '').trim();
  }
  if (el.id) {
    const label = el.ownerDocument?.querySelector(`label[for="${cssEscape(el.id)}"]`);
    if (label) return (label.textContent ?? '').trim();
  }
  const placeholder = el.getAttribute('placeholder');
  if (placeholder) return placeholder.trim();
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Minimal escape for the attribute values the fixtures use. */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
