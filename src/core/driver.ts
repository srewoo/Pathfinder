/**
 * The Driver port (fix.md §2).
 *
 * The single boundary between engine logic and the browser. Everything in
 * `src/core/**` talks to the page exclusively through this interface and MUST
 * NOT import `chrome.*` — enforced by the ESLint rule in `.eslintrc.cjs`.
 *
 * Two implementations live in `src/drivers/`:
 *   - `cdp-driver.ts`  — real Chrome, via chrome.debugger
 *   - `fake-driver.ts` — in-memory, for unit tests with no browser and no API key
 *
 * The fake driver is the point of the exercise: it makes the planner, executor,
 * graph and healing logic testable without a tab.
 */
import type { Locator } from './locator';
import type { ActionabilityCheck, ElementSample, Rect } from './actionability';

// ── Handles ─────────────────────────────────────────────────────────────────

/**
 * An opaque reference to a resolved element.
 *
 * `tier` records which locator tier actually resolved it — the input to heal
 * reporting (§5) and the testability report. `healed` is true when resolution
 * fell below the locator's `preferredTier`.
 */
export interface ElementHandle {
  readonly ref: string;
  readonly locator: Locator;
  readonly tier: 'testid' | 'semantic' | 'structural';
  readonly healed: boolean;
  readonly rect: Rect | null;
  /** Selector that actually resolved, when the tier was structural. */
  readonly resolvedCss?: string;
}

// ── Page data ───────────────────────────────────────────────────────────────

export interface DriverPageSnapshot {
  url: string;
  title: string;
  /** Serialized accessibility tree, when the driver can produce one. */
  axTree?: string;
  /** Visible text, collapsed and capped by the driver. */
  text?: string;
  html?: string;
}

export interface NetworkRequest {
  requestId: string;
  url: string;
  method: string;
  resourceType?: string;
}

export interface NetworkResponse {
  requestId: string;
  url: string;
  method: string;
  status: number;
  statusText?: string;
  mimeType?: string;
  durationMs?: number;
}

/**
 * Verdict returned by the request interceptor. `abort` is how the origin
 * allowlist and the method gate (§7) refuse a request — enforced inside the
 * driver so no caller can bypass it.
 */
export type RequestVerdict = { action: 'continue' } | { action: 'abort'; reason: string };

// ── Options ─────────────────────────────────────────────────────────────────

export interface WaitOptions {
  timeoutMs?: number;
  /** Defaults to the action's required set via `checksForAction`. */
  checks?: readonly ActionabilityCheck[];
}

export interface TypeOptions extends WaitOptions {
  /** Clear the field before typing. Defaults to true. */
  clear?: boolean;
  /** Verify the value landed after typing. Defaults to true. */
  verify?: boolean;
}

export interface ClickOptions extends WaitOptions {
  /** Dispatch a second click ~50ms later. */
  double?: boolean;
}

// ── The port ────────────────────────────────────────────────────────────────

export interface Driver {
  // — Lifecycle —
  /** Attach to the target. Idempotent. */
  open(): Promise<void>;
  /** Release the target. Idempotent and safe after the tab is gone. */
  close(): Promise<void>;

  // — Navigation —
  navigate(url: string): Promise<void>;
  currentUrl(): Promise<string>;

  // — Inspection —
  snapshot(): Promise<DriverPageSnapshot>;
  /**
   * Resolve a locator through the tier ladder. Returns null when no tier
   * matches. Does NOT wait — use `waitFor` for that.
   */
  resolve(locator: Locator): Promise<ElementHandle | null>;
  /** Sample actionability state for a resolved handle. */
  sample(handle: ElementHandle): Promise<ElementSample>;
  /**
   * Poll until the locator resolves AND satisfies `checks`.
   * Throws `NotActionableError` on timeout.
   */
  waitFor(locator: Locator, opts?: WaitOptions): Promise<ElementHandle>;

  // — Actions. Each asserts its actionability preconditions internally (§8). —
  click(locator: Locator, opts?: ClickOptions): Promise<ElementHandle>;
  type(locator: Locator, text: string, opts?: TypeOptions): Promise<ElementHandle>;
  clear(locator: Locator, opts?: WaitOptions): Promise<ElementHandle>;
  hover(locator: Locator, opts?: WaitOptions): Promise<ElementHandle>;
  setChecked(locator: Locator, checked: boolean, opts?: WaitOptions): Promise<ElementHandle>;
  selectOption(locator: Locator, value: string, opts?: WaitOptions): Promise<ElementHandle>;
  pressKey(key: string, locator?: Locator, opts?: WaitOptions): Promise<void>;
  dragDrop(from: Locator, to: Locator, opts?: WaitOptions): Promise<void>;
  uploadFile(locator: Locator, fileNames: string[], opts?: WaitOptions): Promise<ElementHandle>;
  scroll(target: { locator?: Locator; to?: 'top' | 'bottom'; px?: number }): Promise<void>;

  // — Reading —
  readText(locator: Locator, opts?: WaitOptions): Promise<string>;
  readValue(locator: Locator, opts?: WaitOptions): Promise<string>;
  readAttribute(locator: Locator, attribute: string, opts?: WaitOptions): Promise<string | null>;
  count(locator: Locator): Promise<number>;

  // — Escape hatch. Page-side analysis (occlusion, sticky offsets, toasts). —
  evaluate<T = unknown>(expression: string): Promise<T>;

  // — Artifacts —
  screenshot(): Promise<string | undefined>;

  // — Network —
  /**
   * Register the request interceptor. The driver applies the verdict itself;
   * §7's safety controls are installed here.
   */
  onRequest(cb: (r: NetworkRequest) => RequestVerdict): void;
  onResponse(cb: (r: NetworkResponse) => void): void;
  /** Responses observed since `open()`. */
  networkLog(): readonly NetworkResponse[];

  // — Dialogs —
  /** Auto-dismiss JS dialogs so they cannot deadlock the session. */
  autoDismissDialogs(enabled: boolean): Promise<void>;
}

// ── Capability reporting ────────────────────────────────────────────────────

/**
 * Not every driver can do everything. The fake driver has no real network
 * stack; a CDP session on a restricted page cannot attach at all. Callers
 * degrade explicitly rather than discovering a silent no-op.
 */
export interface DriverCapabilities {
  trustedInput: boolean;
  networkInterception: boolean;
  screenshots: boolean;
  accessibilityTree: boolean;
}

export interface DriverWithCapabilities extends Driver {
  capabilities(): DriverCapabilities;
}

export class DriverError extends Error {
  readonly isOperational = true;
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'DriverError';
  }
}

/** Thrown when a locator cannot be resolved by any tier. */
export class ElementNotFoundError extends Error {
  readonly isOperational = true;
  constructor(readonly target: string) {
    super(`No element matched locator ${target}`);
    this.name = 'ElementNotFoundError';
  }
}
