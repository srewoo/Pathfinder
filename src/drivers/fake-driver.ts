/**
 * In-memory Driver (fix.md §2).
 *
 * Models a page as a flat list of elements with scriptable behaviour, so the
 * planner, executor, graph and healing logic can be tested with no browser, no
 * tab, and no API key.
 *
 * It is deliberately a real state machine, not a stub returning canned values:
 * typing mutates element values, clicking fires registered handlers that can
 * navigate or reveal elements, and animation can be simulated so the §8
 * stability check is genuinely exercised.
 */
import type {
  Driver,
  DriverCapabilities,
  DriverPageSnapshot,
  DriverWithCapabilities,
  ElementHandle,
  NetworkRequest,
  NetworkResponse,
  RequestVerdict,
  ClickOptions,
  TypeOptions,
  WaitOptions,
} from '../core/driver';
import { ElementNotFoundError } from '../core/driver';
import type { Locator } from '../core/locator';
import { bestTier, describeLocator, tiersOf } from '../core/locator';
import type { ElementSample, Rect } from '../core/actionability';
import {
  NotActionableError,
  checksForAction,
  evaluateActionability,
} from '../core/actionability';

// ── Page model ──────────────────────────────────────────────────────────────

export interface FakeElement {
  id: string;
  tag: string;
  role?: string;
  name?: string;
  testid?: string;
  css?: string;
  text?: string;
  value?: string;
  checked?: boolean;
  options?: string[];
  attrs?: Record<string, string>;
  attached?: boolean;
  visible?: boolean;
  enabled?: boolean;
  rect?: Rect;
  /** When set, the element is obscured and fails `receivesEvents`. */
  obscuredBy?: string;
  /**
   * Number of samples the element's box keeps moving for. Decremented on each
   * sample; while > 0 the rect drifts, so `stable` cannot pass. Simulates a
   * CSS transition.
   */
  movingForSamples?: number;
  /** Invoked on click. May mutate the page — navigate, reveal, etc. */
  onClick?: (page: FakePage) => void;
}

export interface FakePage {
  url: string;
  title: string;
  elements: FakeElement[];
}

export interface FakeDriverOptions {
  /** Poll interval used by waitFor. Small by default to keep tests fast. */
  pollMs?: number;
  /** Default action timeout. */
  timeoutMs?: number;
}

const DEFAULT_RECT: Rect = { x: 10, y: 10, width: 100, height: 30 };

export interface FakeDriver extends DriverWithCapabilities {
  /** Replace the current page wholesale. */
  setPage(page: Partial<FakePage> & { elements: FakeElement[] }): void;
  page(): FakePage;
  /** Element mutation helper for tests. */
  patch(id: string, patch: Partial<FakElementPatch>): void;
  /** Every action performed, in order — the assertion surface for tests. */
  actionLog(): readonly string[];
  /** Feed a synthetic request through the registered interceptor. */
  emitRequest(req: NetworkRequest): RequestVerdict;
  emitResponse(res: NetworkResponse): void;
}

type FakElementPatch = Omit<FakeElement, 'id'>;

export function createFakeDriver(
  initial: Partial<FakePage> & { elements?: FakeElement[] } = {},
  opts: FakeDriverOptions = {}
): FakeDriver {
  const pollMs = opts.pollMs ?? 5;
  const defaultTimeout = opts.timeoutMs ?? 1_000;

  let page: FakePage = {
    url: initial.url ?? 'https://app.test/',
    title: initial.title ?? 'Fake',
    elements: initial.elements ?? [],
  };

  let opened = false;
  const log: string[] = [];
  const responses: NetworkResponse[] = [];
  let requestCb: ((r: NetworkRequest) => RequestVerdict) | null = null;
  let responseCb: ((r: NetworkResponse) => void) | null = null;
  let dialogsDismissed = false;
  let refCounter = 0;

  // ── Resolution ────────────────────────────────────────────────────────────

  function matches(el: FakeElement, loc: Locator, tier: string): boolean {
    if (el.attached === false) return false;
    switch (tier) {
      case 'testid':
        return Boolean(loc.testid && el.testid === loc.testid);
      case 'semantic': {
        if (!loc.semantic) return false;
        if (el.role !== loc.semantic.role) return false;
        const want = loc.semantic.name;
        const got = el.name ?? el.text ?? '';
        return loc.semantic.exact ? got === want : got.includes(want);
      }
      case 'structural':
        // Not a CSS engine: the fake matches on recorded css or element id, which
        // is enough to exercise tier-ordering and heal-reporting logic.
        return Boolean(
          loc.structural &&
            (el.css === loc.structural.css || el.id === loc.structural.css.replace(/^#/, ''))
        );
      default:
        return false;
    }
  }

  function resolveSync(loc: Locator): ElementHandle | null {
    const preferred = bestTier(loc);
    for (const tier of tiersOf(loc)) {
      const el = page.elements.find((e) => matches(e, loc, tier));
      if (el) {
        return {
          ref: `fake-${++refCounter}:${el.id}`,
          locator: loc,
          tier: tier as ElementHandle['tier'],
          healed: tier !== preferred,
          rect: el.rect ?? DEFAULT_RECT,
          resolvedCss: tier === 'structural' ? loc.structural?.css : undefined,
        };
      }
    }
    return null;
  }

  function elementOf(handle: ElementHandle): FakeElement | undefined {
    const id = handle.ref.split(':')[1];
    return page.elements.find((e) => e.id === id);
  }

  function sampleOf(el: FakeElement | undefined): ElementSample {
    if (!el) {
      return { attached: false, visible: false, enabled: false, rect: null, receivesEvents: false };
    }
    // Simulate motion: while movingForSamples > 0 the box drifts, so two
    // consecutive samples never agree and `stable` cannot pass.
    let rect = el.rect ?? DEFAULT_RECT;
    if ((el.movingForSamples ?? 0) > 0) {
      el.movingForSamples = (el.movingForSamples ?? 0) - 1;
      rect = { ...rect, y: rect.y + 5 };
      el.rect = rect;
    }
    return {
      attached: el.attached !== false,
      visible: el.visible !== false,
      enabled: el.enabled !== false,
      rect,
      receivesEvents: !el.obscuredBy,
      obscuredBy: el.obscuredBy,
    };
  }

  async function waitForInternal(
    loc: Locator,
    action: string,
    opts?: WaitOptions
  ): Promise<ElementHandle> {
    const timeoutMs = opts?.timeoutMs ?? defaultTimeout;
    const checks = opts?.checks ?? checksForAction(action);
    const deadline = Date.now() + timeoutMs;
    let previous: ElementSample | null = null;
    let lastVerdict = evaluateActionability(
      { attached: false, visible: false, enabled: false, rect: null, receivesEvents: false },
      null,
      checks
    );

    for (;;) {
      const handle = resolveSync(loc);
      if (handle) {
        const current = sampleOf(elementOf(handle));
        const verdict = evaluateActionability(current, previous, checks);
        if (verdict.actionable) return { ...handle, rect: current.rect };
        lastVerdict = verdict;
        previous = current;
      } else {
        previous = null;
      }
      if (Date.now() >= deadline) {
        throw new NotActionableError(describeLocator(loc), lastVerdict, timeoutMs);
      }
      await sleep(pollMs);
    }
  }

  function requireEl(handle: ElementHandle): FakeElement {
    const el = elementOf(handle);
    if (!el) throw new ElementNotFoundError(describeLocator(handle.locator));
    return el;
  }

  // ── Driver surface ────────────────────────────────────────────────────────

  const driver: FakeDriver = {
    async open() {
      opened = true;
      log.push('open');
    },
    async close() {
      opened = false;
      log.push('close');
    },

    async navigate(url) {
      if (!opened) await driver.open();
      page = { ...page, url };
      log.push(`navigate ${url}`);
    },
    async currentUrl() {
      return page.url;
    },

    async snapshot(): Promise<DriverPageSnapshot> {
      return {
        url: page.url,
        title: page.title,
        text: page.elements.map((e) => e.text ?? '').filter(Boolean).join(' '),
        axTree: page.elements
          .filter((e) => e.role)
          .map((e) => `${e.role} "${e.name ?? e.text ?? ''}"`)
          .join('\n'),
      };
    },

    async resolve(loc) {
      return resolveSync(loc);
    },

    async sample(handle) {
      return sampleOf(elementOf(handle));
    },

    async waitFor(loc, opts) {
      return waitForInternal(loc, 'click', opts);
    },

    async click(loc, opts?: ClickOptions) {
      const handle = await waitForInternal(loc, opts?.double ? 'double_click' : 'click', opts);
      const el = requireEl(handle);
      log.push(`click ${el.id}${opts?.double ? ' (double)' : ''}`);
      el.onClick?.(page);
      return handle;
    },

    async type(loc, text, opts?: TypeOptions) {
      const handle = await waitForInternal(loc, 'type', opts);
      const el = requireEl(handle);
      if (opts?.clear !== false) el.value = '';
      el.value = `${el.value ?? ''}${text}`;
      log.push(`type ${el.id} "${text}"`);
      if (opts?.verify !== false && !(el.value ?? '').includes(text)) {
        throw new Error(`Typed value did not land in ${el.id}`);
      }
      return handle;
    },

    async clear(loc, opts) {
      const handle = await waitForInternal(loc, 'clear', opts);
      const el = requireEl(handle);
      el.value = '';
      log.push(`clear ${el.id}`);
      return handle;
    },

    async hover(loc, opts) {
      const handle = await waitForInternal(loc, 'hover', opts);
      log.push(`hover ${requireEl(handle).id}`);
      return handle;
    },

    async setChecked(loc, checked, opts) {
      const handle = await waitForInternal(loc, checked ? 'check' : 'uncheck', opts);
      const el = requireEl(handle);
      el.checked = checked;
      log.push(`setChecked ${el.id} ${checked}`);
      return handle;
    },

    async selectOption(loc, value, opts) {
      const handle = await waitForInternal(loc, 'select', opts);
      const el = requireEl(handle);
      if (el.options && !el.options.includes(value)) {
        throw new Error(`Option "${value}" not present in ${el.id}`);
      }
      el.value = value;
      log.push(`selectOption ${el.id} "${value}"`);
      return handle;
    },

    async pressKey(key, loc, opts) {
      if (loc) await waitForInternal(loc, 'press_key', opts);
      log.push(`pressKey ${key}`);
    },

    async dragDrop(from, to, opts) {
      const a = await waitForInternal(from, 'drag_drop', opts);
      const b = await waitForInternal(to, 'drag_drop', opts);
      log.push(`dragDrop ${requireEl(a).id} -> ${requireEl(b).id}`);
    },

    async uploadFile(loc, fileNames, opts) {
      const handle = await waitForInternal(loc, 'upload_file', opts);
      const el = requireEl(handle);
      el.value = fileNames.join(',');
      log.push(`uploadFile ${el.id} [${fileNames.join(', ')}]`);
      return handle;
    },

    async scroll(target) {
      log.push(`scroll ${target.to ?? target.px ?? (target.locator ? 'to-element' : 'noop')}`);
    },

    async readText(loc, opts) {
      const handle = await waitForInternal(loc, 'capture_value', opts);
      return requireEl(handle).text ?? '';
    },

    async readValue(loc, opts) {
      const handle = await waitForInternal(loc, 'capture_value', opts);
      return requireEl(handle).value ?? '';
    },

    async readAttribute(loc, attribute, opts) {
      const handle = await waitForInternal(loc, 'capture_value', opts);
      return requireEl(handle).attrs?.[attribute] ?? null;
    },

    async count(loc) {
      for (const tier of tiersOf(loc)) {
        const n = page.elements.filter((e) => matches(e, loc, tier)).length;
        if (n > 0) return n;
      }
      return 0;
    },

    async evaluate<T>(expression: string): Promise<T> {
      log.push(`evaluate ${expression.slice(0, 40)}`);
      return undefined as unknown as T;
    },

    async screenshot() {
      return 'data:image/png;base64,ZmFrZQ==';
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
      dialogsDismissed = enabled;
      log.push(`autoDismissDialogs ${enabled}`);
    },

    capabilities(): DriverCapabilities {
      return {
        trustedInput: false,
        networkInterception: true,
        screenshots: true,
        accessibilityTree: true,
      };
    },

    // ── Test helpers ───────────────────────────────────────────────────────

    setPage(next) {
      page = {
        url: next.url ?? page.url,
        title: next.title ?? page.title,
        elements: next.elements,
      };
    },
    page() {
      return page;
    },
    patch(id, patch) {
      const el = page.elements.find((e) => e.id === id);
      if (!el) throw new Error(`No fake element "${id}"`);
      Object.assign(el, patch);
    },
    actionLog() {
      return log;
    },
    emitRequest(req) {
      const verdict = requestCb?.(req) ?? { action: 'continue' as const };
      log.push(`request ${req.method} ${req.url} -> ${verdict.action}`);
      return verdict;
    },
    emitResponse(res) {
      responses.push(res);
      responseCb?.(res);
    },
  };

  // Referenced so the flag is observable in tests without widening the surface.
  void dialogsDismissed;

  return driver;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Convenience: a driver typed as the narrow port, for call sites under test. */
export function asDriver(d: FakeDriver): Driver {
  return d;
}
