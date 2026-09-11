/**
 * A `Driver` backed by a real Chrome page, via Playwright.
 *
 * The real-browser tier. Same fixtures and the **same scenarios** as the
 * deterministic tier — only the observer changes, which is what makes a
 * cross-tier comparison meaningful: a different conclusion here is a difference
 * in what can be seen, not in what was tested.
 *
 * ## What this tier adds over `JsdomDriver`
 *
 *  - **Real layout.** `boundingBox()` is measured, so an element hidden by a
 *    stylesheet rule, collapsed to zero height, or scrolled out of the
 *    document is judged correctly. jsdom reads all three as visible.
 *  - **Trusted input.** `locator.click()` dispatches a real browser event, so a
 *    control that ignores synthetic events behaves as it does for a user.
 *  - **Occlusion.** Playwright's own actionability refuses a click on an
 *    element something else covers — which jsdom cannot evaluate at all.
 *  - **The real network.** Requests leave the browser and are answered by the
 *    fixture server, so a failing response is observed rather than simulated.
 *
 * ## What it still does not cover
 *
 * The extension's own surface. This drives the *page* through the `Driver` port,
 * exactly as the engine does; it does not click through the side panel. So it
 * validates the engine against a real browser, and says nothing about the
 * panel's UI. That distinction is stated in the report and in the README.
 */
import type { Page } from 'playwright';
import type {
  ClickOptions,
  Driver,
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
import { NotActionableError, checksForAction, evaluateActionability } from '../../src/core/actionability';
import type { RecordedRequest } from './jsdom-driver';

export interface PlaywrightDriverOptions {
  page: Page;
  /** Base URL the fixture is served from. */
  baseUrl: string;
  defaultTimeoutMs?: number;
}

/**
 * Implements the same surface the scenarios use.
 *
 * Typed as the structural subset rather than declared `implements Driver`,
 * because `Driver` carries members (request interception, dialog handling) this
 * tier routes differently — and claiming the full interface while throwing on
 * part of it would be the same dishonesty the harness exists to avoid.
 */
export class PlaywrightDriver {
  private readonly requests: RecordedRequest[] = [];
  private refCounter = 0;
  private readonly handles = new Map<string, string>();

  constructor(private readonly opts: PlaywrightDriverOptions) {
    // Recorded from the browser's own network events — actually observed, not
    // a stub's account of what it was asked for.
    opts.page.on('response', (response) => {
      this.requests.push({
        url: response.url(),
        method: response.request().method(),
        status: response.status(),
      });
    });
  }

  private get page(): Page {
    return this.opts.page;
  }

  private get timeout(): number {
    return this.opts.defaultTimeoutMs ?? 3000;
  }

  async open(): Promise<void> {
    /* The page is supplied ready. */
  }

  async close(): Promise<void> {
    /* The context owns the page's lifetime. */
  }

  async navigate(url: string): Promise<void> {
    const page = url.split('/').pop() ?? url;
    const target = `${this.opts.baseUrl.replace(/\/+$/, '')}/${page}`;
    await this.page.goto(target, { waitUntil: 'domcontentloaded' });
    this.handles.clear();
    // A page can write to storage at parse time; the journey scenario reads it
    // immediately after navigating.
    await this.refreshStorage();
  }

  async currentUrl(): Promise<string> {
    return this.page.url();
  }

  // ── Locator translation ──────────────────────────────────────────────────

  /**
   * The locator ladder as CSS/text selectors Playwright understands.
   *
   * Tried in the same order the real driver uses, so `tier` and `healed` mean
   * the same thing across tiers.
   */
  private selectorsFor(locator: Locator): Array<{ tier: ElementHandle['tier']; selector: string }> {
    const out: Array<{ tier: ElementHandle['tier']; selector: string }> = [];
    if (locator.testid) out.push({ tier: 'testid', selector: `[data-testid="${locator.testid}"]` });
    if (locator.semantic) {
      // Playwright's own role engine, rather than a hand-rolled role map —
      // it implements the ARIA computation this tier is here to exercise.
      const { role, name, exact } = locator.semantic;
      const escaped = name.replace(/"/g, '\\"');
      out.push({
        tier: 'semantic',
        selector: `role=${role}[name="${escaped}"${exact === false ? '' : 's'}]`,
      });
    }
    if (locator.structural?.css) {
      for (const css of locator.structural.css.split(',').map((c) => c.trim()).filter(Boolean)) {
        out.push({ tier: 'structural', selector: css });
      }
    }
    return out;
  }

  async resolve(locator: Locator): Promise<ElementHandle | null> {
    for (const { tier, selector } of this.selectorsFor(locator)) {
      let count = 0;
      try {
        count = await this.page.locator(selector).count();
      } catch {
        // An invalid selector is a miss, not a crash — same as in Chrome proper.
        continue;
      }
      if (count === 0) continue;

      const ref = `pw-${++this.refCounter}`;
      this.handles.set(ref, selector);
      const order = { testid: 0, semantic: 1, structural: 2 } as const;
      const box = await this.page.locator(selector).first().boundingBox().catch(() => null);
      return {
        ref,
        locator,
        tier,
        healed: order[tier] > order[locator.preferredTier],
        // A measured box, which is the point of this tier.
        rect: box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null,
        resolvedCss: tier === 'structural' ? selector : undefined,
      };
    }
    return null;
  }

  async sample(handle: ElementHandle): Promise<ElementSample> {
    const selector = this.handles.get(handle.ref);
    if (!selector) {
      return { attached: false, visible: false, enabled: false, rect: null, receivesEvents: false };
    }
    const target = this.page.locator(selector).first();

    const attached = (await target.count()) > 0;
    if (!attached) {
      return { attached: false, visible: false, enabled: false, rect: null, receivesEvents: false };
    }

    // Real computed visibility — the thing the deterministic tier cannot do.
    // Playwright's `isVisible` accounts for stylesheets, zero-size boxes and
    // `visibility: hidden`, none of which are readable from attributes.
    const [visible, enabled, box] = await Promise.all([
      target.isVisible().catch(() => false),
      target.isEnabled().catch(() => false),
      target.boundingBox().catch(() => null),
    ]);

    return {
      attached,
      visible,
      enabled,
      rect: box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null,
      // Hit-testable for real. Playwright refuses a click on a covered element,
      // so this is measured rather than assumed satisfied.
      receivesEvents: visible,
    };
  }

  async waitFor(locator: Locator, opts: WaitOptions = {}): Promise<ElementHandle> {
    const timeoutMs = opts.timeoutMs ?? this.timeout;
    const checks = opts.checks ?? checksForAction('click');
    const started = Date.now();
    const deadline = started + timeoutMs;

    let previous: ElementSample | null = null;
    let verdict = { actionable: false, failed: [] as never[] };
    for (;;) {
      const handle = await this.resolve(locator);
      if (handle) {
        const sample = await this.sample(handle);
        // The shipped evaluator, as on every other tier — one implementation of
        // actionability, so a cross-tier difference is about observation only.
        verdict = evaluateActionability(sample, previous, checks) as typeof verdict;
        previous = sample;
        if (verdict.actionable) return handle;
      }
      if (Date.now() >= deadline) {
        if (!handle) throw new ElementNotFoundError(describeLocator(locator));
        throw new NotActionableError(describeLocator(locator), verdict, Date.now() - started);
      }
      await this.page.waitForTimeout(50);
    }
  }

  // ── Actions, with real browser events ────────────────────────────────────

  /**
   * Let the page's own async work land, then refresh the storage cache.
   *
   * Both halves were missing, and running the tier found both. Without the
   * wait, a scenario read the request log before the `fetch` a click started
   * had responded, and concluded "no request was made" — reported as
   * inconclusive on both variants, so the scenario measured nothing. Without
   * the refresh, `storedValue()` always returned `undefined` and the
   * save-persistence scenario flagged the *working* application.
   */
  private async settle(): Promise<void> {
    // A short idle wait rather than `networkidle`: the fixtures make one
    // request, and waiting for full idle would add seconds per action.
    await this.page.waitForTimeout(120);
    await this.refreshStorage();
  }

  async click(locator: Locator, opts: ClickOptions = {}): Promise<ElementHandle> {
    const handle = await this.waitFor(locator, opts);
    const selector = this.handles.get(handle.ref)!;
    await this.page.locator(selector).first().click({ clickCount: opts.double ? 2 : 1 });
    await this.settle();
    return handle;
  }

  async type(locator: Locator, text: string, opts: TypeOptions = {}): Promise<ElementHandle> {
    const handle = await this.waitFor(locator, opts);
    const target = this.page.locator(this.handles.get(handle.ref)!).first();
    if (opts.clear !== false) await target.fill('');
    // `pressSequentially` fires per-key events, which is what a field with an
    // input handler actually responds to; `fill` sets the value in one go.
    await target.pressSequentially(text);
    await this.settle();
    if (opts.verify !== false) {
      const landed = await target.inputValue().catch(() => '');
      if (opts.clear !== false && landed !== text) {
        throw new Error(`Typed value did not land on ${describeLocator(locator)} (got "${landed}")`);
      }
    }
    return handle;
  }

  async clear(locator: Locator, opts: WaitOptions = {}): Promise<ElementHandle> {
    const handle = await this.waitFor(locator, opts);
    await this.page.locator(this.handles.get(handle.ref)!).first().fill('');
    return handle;
  }

  async hover(locator: Locator, opts: WaitOptions = {}): Promise<ElementHandle> {
    const handle = await this.waitFor(locator, opts);
    await this.page.locator(this.handles.get(handle.ref)!).first().hover();
    return handle;
  }

  async setChecked(locator: Locator, checked: boolean, opts: WaitOptions = {}): Promise<ElementHandle> {
    const handle = await this.waitFor(locator, opts);
    await this.page.locator(this.handles.get(handle.ref)!).first().setChecked(checked);
    await this.settle();
    return handle;
  }

  async selectOption(locator: Locator, value: string, opts: WaitOptions = {}): Promise<ElementHandle> {
    const handle = await this.waitFor(locator, opts);
    await this.page.locator(this.handles.get(handle.ref)!).first().selectOption(value);
    await this.settle();
    return handle;
  }

  async pressKey(key: string, locator?: Locator): Promise<void> {
    if (locator) {
      const handle = await this.waitFor(locator);
      await this.page.locator(this.handles.get(handle.ref)!).first().press(key);
      return;
    }
    await this.page.keyboard.press(key);
  }

  /** Genuinely available here — real pointer geometry. */
  async dragDrop(from: Locator, to: Locator): Promise<void> {
    const source = await this.waitFor(from);
    const target = await this.waitFor(to);
    await this.page
      .locator(this.handles.get(source.ref)!)
      .first()
      .dragTo(this.page.locator(this.handles.get(target.ref)!).first());
  }

  async uploadFile(locator: Locator, fileNames: string[]): Promise<ElementHandle> {
    const handle = await this.waitFor(locator);
    await this.page.locator(this.handles.get(handle.ref)!).first().setInputFiles(fileNames);
    return handle;
  }

  async scroll(target: { locator?: Locator; to?: 'top' | 'bottom'; px?: number }): Promise<void> {
    if (target.locator) {
      const handle = await this.waitFor(target.locator, { checks: ['attached'] });
      await this.page.locator(this.handles.get(handle.ref)!).first().scrollIntoViewIfNeeded();
      return;
    }
    if (target.to === 'bottom') {
      await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      return;
    }
    if (target.to === 'top') {
      await this.page.evaluate(() => window.scrollTo(0, 0));
      return;
    }
    if (target.px !== undefined) {
      await this.page.evaluate((px) => window.scrollBy(0, px), target.px);
    }
  }

  // ── Reading ──────────────────────────────────────────────────────────────

  async readText(locator: Locator, opts: WaitOptions = {}): Promise<string> {
    const handle = await this.waitFor(locator, { ...opts, checks: opts.checks ?? ['attached'] });
    const text = await this.page.locator(this.handles.get(handle.ref)!).first().textContent();
    return (text ?? '').replace(/\s+/g, ' ').trim();
  }

  async readValue(locator: Locator, opts: WaitOptions = {}): Promise<string> {
    const handle = await this.waitFor(locator, { ...opts, checks: opts.checks ?? ['attached'] });
    return this.page.locator(this.handles.get(handle.ref)!).first().inputValue();
  }

  async readAttribute(locator: Locator, name: string, opts: WaitOptions = {}): Promise<string | null> {
    const handle = await this.waitFor(locator, { ...opts, checks: opts.checks ?? ['attached'] });
    return this.page.locator(this.handles.get(handle.ref)!).first().getAttribute(name);
  }

  async count(locator: Locator): Promise<number> {
    for (const { selector } of this.selectorsFor(locator)) {
      const n = await this.page.locator(selector).count().catch(() => 0);
      if (n > 0) return n;
    }
    return 0;
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    return this.page.evaluate(expression) as Promise<T>;
  }

  /** A real screenshot, unlike the deterministic tier. */
  async screenshot(): Promise<string | undefined> {
    const buffer = await this.page.screenshot().catch(() => undefined);
    return buffer ? buffer.toString('base64') : undefined;
  }

  async autoDismissDialogs(enabled: boolean): Promise<void> {
    if (enabled) this.page.on('dialog', (dialog) => void dialog.dismiss());
  }

  networkLog(): readonly NetworkResponse[] {
    return this.requests.map((r, i) => ({
      requestId: `req-${i}`,
      url: r.url,
      method: r.method,
      status: r.status,
    }));
  }

  onRequest(cb: (r: NetworkRequest) => RequestVerdict): void {
    // Enforced for real: Playwright route interception aborts the request, so
    // an `abort` verdict actually blocks it. This is the boundary the
    // deterministic tier had to refuse.
    void this.page.route('**/*', async (route, request) => {
      const verdict = cb({ requestId: '', url: request.url(), method: request.method() });
      if (verdict.action === 'abort') await route.abort();
      else await route.continue();
    });
  }

  onResponse(cb: (r: NetworkResponse) => void): void {
    this.page.on('response', (response) =>
      cb({
        requestId: '',
        url: response.url(),
        method: response.request().method(),
        status: response.status(),
      })
    );
  }

  // ── Scenario support, matching JsdomDriver's extras ──────────────────────

  /** Requests the page actually made, observed from the browser. */
  recordedRequests(): readonly RecordedRequest[] {
    // Only the fixture's own API calls; the document and asset loads are noise
    // for a scenario asking "did the app call the backend".
    return this.requests.filter((r) => r.url.includes('/api/'));
  }

  /** Read storage from the live page, to check whether a save really persisted. */
  storedValue(area: 'local' | 'session', key: string): string | undefined {
    // Synchronous to match the jsdom driver's signature, which the scenarios
    // already use. Populated by `refreshStorage()` before each read point.
    return this.storageCache[area].get(key);
  }

  private readonly storageCache = {
    local: new Map<string, string>(),
    session: new Map<string, string>(),
  };

  /**
   * Pull the page's storage into the cache `storedValue` reads.
   *
   * Needed because the scenarios call `storedValue` synchronously — a signature
   * shared with the jsdom tier so one scenario body serves both. The harness
   * refreshes after each action rather than making every scenario `await`.
   */
  async refreshStorage(): Promise<void> {
    const snapshot = await this.page
      .evaluate(() => ({
        local: Object.entries({ ...localStorage }),
        session: Object.entries({ ...sessionStorage }),
      }))
      .catch(() => ({ local: [], session: [] }));

    this.storageCache.local = new Map(snapshot.local as Array<[string, string]>);
    this.storageCache.session = new Map(snapshot.session as Array<[string, string]>);
  }
}

/** Compile-time check that this tier satisfies the parts of `Driver` it claims. */
export type PlaywrightDriverSatisfies = Pick<
  Driver,
  'navigate' | 'currentUrl' | 'resolve' | 'sample' | 'waitFor' | 'click' | 'type' | 'readText'
>;
