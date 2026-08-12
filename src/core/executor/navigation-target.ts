/**
 * Where a `navigate` step is actually allowed to go.
 *
 * The failure this exists for, observed during a real run: a generated step
 * carried the value `/university/command-center` — a path, not a URL. Nothing
 * checked it, `chrome.tabs.update` resolves a relative URL against the
 * EXTENSION's base, and the tab landed on
 *
 *   chrome-extension://mccnppbdegniiipcffblljjbfllalahp/university/command-center
 *   → ERR_FILE_NOT_FOUND
 *
 * Everything after that point was executed against a Chrome error page, so every
 * later step failed for the wrong reason and the report blamed the app.
 *
 * Two rules, both of which that run needed:
 *   1. resolve a relative target against the page we are on, the way a browser
 *      would — not against whatever origin the caller happens to live at
 *   2. refuse a target that cannot possibly be the app under test, loudly, instead
 *      of navigating there and failing obscurely afterwards
 */

/** Schemes a test can legitimately navigate to. */
const APP_SCHEMES = new Set(['http:', 'https:']);

/**
 * Schemes that are never the app under test.
 *
 * `chrome-extension:` is the one that bit us — it is where a relative URL resolves
 * to when the extension resolves it — but `file:`, `chrome:` and `devtools:` are
 * equally certain signs that a step is pointing somewhere it should not.
 */
const REFUSED_SCHEMES = new Set([
  'chrome-extension:', 'moz-extension:', 'chrome:', 'edge:', 'about:',
  'devtools:', 'file:', 'data:', 'blob:', 'javascript:', 'view-source:',
]);

export interface NavigationContext {
  /** URL of the page the tab is currently on, if known. */
  currentUrl?: string;
  /** The test's declared start URL — the fallback base. */
  startUrl?: string;
}

export type NavigationTarget =
  | { ok: true; url: string; resolvedFrom?: string }
  | { ok: false; error: string };

function schemeOf(value: string): string | null {
  const m = /^([a-z][a-z0-9+.-]*:)/i.exec(value.trim());
  return m ? m[1].toLowerCase() : null;
}

function usableBase(candidate: string | undefined): string | null {
  if (!candidate) return null;
  try {
    const u = new URL(candidate);
    return APP_SCHEMES.has(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Resolve and vet a `navigate` target.
 *
 * Returns an error rather than a best guess when no usable base exists. Guessing
 * would put the run on some unrelated origin and report the results as the app's.
 */
export function resolveNavigationTarget(
  value: string,
  ctx: NavigationContext = {}
): NavigationTarget {
  const raw = (value ?? '').trim();
  if (!raw) return { ok: false, error: 'navigate step has no URL' };

  const scheme = schemeOf(raw);
  if (scheme && REFUSED_SCHEMES.has(scheme)) {
    return {
      ok: false,
      error:
        `refusing to navigate to "${raw.slice(0, 80)}" — ${scheme} is never the app ` +
        `under test. A relative path in a navigate step resolves against the ` +
        `extension, which is how a step like "/path" becomes a ${scheme} URL.`,
    };
  }
  if (scheme && !APP_SCHEMES.has(scheme)) {
    return { ok: false, error: `refusing to navigate to unsupported scheme ${scheme}` };
  }

  // Already absolute and allowed.
  if (scheme) {
    try {
      return { ok: true, url: new URL(raw).toString() };
    } catch {
      return { ok: false, error: `navigate target is not a valid URL: "${raw.slice(0, 80)}"` };
    }
  }

  // Relative (including protocol-relative "//host/path"). Resolve against the page
  // we are on; fall back to the test's start URL.
  const base = usableBase(ctx.currentUrl) ?? usableBase(ctx.startUrl);
  if (!base) {
    return {
      ok: false,
      error:
        `navigate target "${raw.slice(0, 80)}" is a relative path and there is no ` +
        `app page to resolve it against (current page: ${ctx.currentUrl ?? 'unknown'}). ` +
        `Give the step an absolute URL, or set the test's start URL.`,
    };
  }
  try {
    return { ok: true, url: new URL(raw, base).toString(), resolvedFrom: base };
  } catch {
    return { ok: false, error: `could not resolve "${raw.slice(0, 80)}" against ${base}` };
  }
}

/** True when a value can be used as-is, with no base needed. */
export function isAbsoluteAppUrl(value: string): boolean {
  const scheme = schemeOf(value ?? '');
  if (!scheme || !APP_SCHEMES.has(scheme)) return false;
  try {
    new URL(value.trim());
    return true;
  } catch {
    return false;
  }
}

/**
 * Was this navigation target ever actually observed, or does it just look plausible?
 *
 * Planning asks a model to turn "go to the command center" into a URL. When the
 * exploration graph is thin the model has nothing to copy from, so it writes a URL
 * that reads correctly and does not exist — which is how a run ended up navigating
 * to `/university/command-center`, a path this app never served.
 *
 * This does not repair anything: inventing a substitute would be the same mistake
 * with a different author. It reports, and names the cause, because the cause is
 * fixable — a wider crawl gives planning real URLs to use.
 */
export interface GroundingContext {
  /** Every URL exploration actually visited. */
  knownUrls: Iterable<string>;
  /** How many pages were mapped, for the message. */
  mappedPageCount: number;
}

export type GroundingVerdict =
  | { grounded: true }
  | { grounded: false; reason: string };

/** Compare URLs ignoring the trailing slash and the fragment. */
function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    const path = u.pathname.replace(/\/$/, '');
    return `${u.origin}${path}${u.search}`;
  } catch {
    return url;
  }
}

export function assessNavigationGrounding(url: string, ctx: GroundingContext): GroundingVerdict {
  const known = new Set<string>();
  for (const k of ctx.knownUrls) known.add(canonicalUrl(k));
  if (known.size === 0) {
    return {
      grounded: false,
      reason:
        `nothing has been explored yet, so no navigation target can be verified. ` +
        `Explore the app first — planning is otherwise guessing URLs.`,
    };
  }
  if (known.has(canonicalUrl(url))) return { grounded: true };

  return {
    grounded: false,
    reason:
      `"${url}" was never visited during exploration (${ctx.mappedPageCount} page(s) mapped). ` +
      (ctx.mappedPageCount <= 1
        ? `With a single page mapped there is no route information to plan from, so this ` +
          `URL was most likely inferred from documentation rather than observed. Re-explore ` +
          `with more depth to ground it.`
        : `It may be invented. Widen the crawl if this page should have been mapped.`),
  };
}
