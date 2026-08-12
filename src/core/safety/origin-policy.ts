/**
 * Origin allowlist + method gate (fix.md §7).
 *
 * Pure policy. The CDP driver installs it as its request interceptor, so no
 * caller can route around it — that placement is the whole control. A test
 * author, a prompt, or a hallucinated step cannot opt out.
 *
 * Two independent gates:
 *   1. Origin allowlist — requests to origins outside the project's declared
 *      list are aborted. Stops accidental crawls into production or a
 *      third-party admin panel.
 *   2. Method gate — mutating verbs are refused unless the run is explicitly
 *      flagged mutating AND the origin is allowlisted.
 */
import { z } from 'zod';

export const MUTATING_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

export const OriginPolicySchema = z.object({
  /**
   * Allowed origins, e.g. `https://app.example.com`. A leading `*.` wildcards
   * the subdomain: `*.example.com` matches `a.example.com` but NOT
   * `example.com` itself, nor `evil-example.com`.
   */
  allowedOrigins: z.array(z.string().min(1)),
  /**
   * When false (the default) every mutating verb is refused. This is the
   * read-only posture: crawl and map, never submit.
   */
  allowMutations: z.boolean().default(false),
  /**
   * Allow the page's own cross-origin READS — fonts, CDN bundles, analytics, API
   * GETs to third parties. On by default: blocking them breaks the app under test,
   * and a broken app produces findings that describe our damage rather than its
   * behaviour.
   *
   * Never covers mutating verbs, and never covers navigation off the allowlist.
   * Turn it off for a hermetic run where any off-allowlist traffic should fail.
   */
  allowThirdPartySubresources: z.boolean().default(true),
});

export type OriginPolicy = z.infer<typeof OriginPolicySchema>;

export type PolicyDecision =
  | { allow: true }
  | { allow: false; reason: string; rule: 'origin' | 'method' };

export interface PolicyRequest {
  url: string;
  method: string;
  /** CDP resource type, when known. */
  resourceType?: string;
  /**
   * The request's `Sec-Fetch-Dest`, when the browser sent one.
   *
   * The only precise way to tell a top-level NAVIGATION (`document`) from an
   * EMBEDDED frame (`iframe`). CDP reports both as resourceType `Document`, so a
   * rule based on resource type alone aborted legitimate embeds — measured against
   * a real app, a Storybook iframe from a design-library host was refused as though
   * the crawler had tried to walk off-site:
   *
   *   BLOCKED Document GET https://design-library.example/stencil-3/iframe.html
   *
   * An `<iframe>` is the page rendering itself; only the top frame moving is the
   * crawler leaving the app.
   */
  destination?: string;
}

/** `Sec-Fetch-Dest` values that mean "embedded in the page", not "navigated to". */
const EMBEDDED_DESTINATIONS = new Set(['iframe', 'frame', 'embed', 'object', 'fencedframe']);

/**
 * Is this request the crawler leaving the app?
 *
 * Prefers `Sec-Fetch-Dest` and falls back to the resource type when the header is
 * absent, which keeps the conservative behaviour for requests the browser did not
 * annotate.
 */
export function isTopLevelNavigation(req: PolicyRequest): boolean {
  const dest = req.destination?.toLowerCase();
  if (dest) {
    if (EMBEDDED_DESTINATIONS.has(dest)) return false;
    return dest === 'document';
  }
  return req.resourceType === 'Document';
}

/**
 * Resource types whose loss means WE broke the page, rather than the policy doing
 * its job. A refusal on one of these is reported loudly, because results from the
 * run cannot be trusted afterwards.
 *
 * `XHR`/`Fetch` are deliberately absent. A refused POST in a read-only run is the
 * mutation gate working exactly as intended — it is recorded in the mutation
 * ledger, and shouting "results are suspect" for each one would train people to
 * ignore the channel that reports real damage.
 */
export const PAGE_CRITICAL_TYPES = new Set(['Script', 'Document', 'Stylesheet']);

/** True when refusing this request would compromise the run's validity. */
export function isPageCritical(resourceType: string | undefined): boolean {
  return resourceType !== undefined && PAGE_CRITICAL_TYPES.has(resourceType);
}

/** Origins that are never test targets and never worth aborting on. */
const ALWAYS_ALLOWED_SCHEMES = new Set(['data:', 'blob:', 'about:', 'chrome-extension:']);

export function createPolicy(input: Partial<OriginPolicy>): OriginPolicy {
  return OriginPolicySchema.parse(input);
}

/**
 * Normalize a URL to its origin. Returns null for unparseable input — treated
 * as a deny, since an origin we cannot determine is one we cannot allowlist.
 */
export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function isOriginAllowed(url: string, allowed: readonly string[]): boolean {
  const origin = originOf(url);
  if (origin === null) return false;

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }

  for (const entry of allowed) {
    const pattern = entry.trim();
    if (!pattern) continue;

    // Wildcard subdomain: `*.example.com`
    if (pattern.startsWith('*.')) {
      const base = pattern.slice(2).toLowerCase();
      const h = host.toLowerCase();
      // Require a real subdomain boundary so `evil-example.com` cannot match
      // `*.example.com`.
      if (h.endsWith(`.${base}`)) return true;
      continue;
    }

    // Exact origin match, or a bare host treated as either scheme.
    const normalized = pattern.toLowerCase();
    if (origin.toLowerCase() === normalized) return true;
    if (!normalized.includes('://') && host.toLowerCase() === normalized) return true;
  }

  return false;
}

export function isMutating(method: string): boolean {
  return (MUTATING_METHODS as readonly string[]).includes(method.toUpperCase());
}

/**
 * The decision function. Order matters: scheme exemption, then origin, then
 * method. Method is checked last so a refusal names the more actionable rule —
 * being off-allowlist is the bigger problem than the verb.
 */
export function decide(req: PolicyRequest, policy: OriginPolicy): PolicyDecision {
  const scheme = schemeOf(req.url);
  if (scheme && ALWAYS_ALLOWED_SCHEMES.has(scheme)) return { allow: true };

  // Fail closed on an empty allowlist. An empty list means we could not work out
  // what we are allowed to touch — not that everything is fine. Relaxing the
  // off-allowlist rule below to permit the page's own reads must not quietly turn
  // "we don't know" into "allow anything", so it is checked first.
  if (policy.allowedOrigins.length === 0) {
    return {
      allow: false,
      rule: 'origin',
      reason: 'no allowed origins are configured — refusing everything (fail closed)',
    };
  }

  const onAllowlist = isOriginAllowed(req.url, policy.allowedOrigins);
  const mutating = isMutating(req.method);

  if (!onAllowlist) {
    // A page's own cross-origin READ is the app working, not the crawler
    // wandering. Enumerating "safe" resource types was the wrong shape for this
    // rule and kept failing in the same direction: first `Script` was missing and
    // module-federation bundles were aborted; then a Google Fonts stylesheet
    // fetched programmatically arrived typed as `XHR` and was aborted too, once
    // every thirty seconds:
    //
    //   BLOCKED XHR GET https://fonts.googleapis.com/css2?family=DM+Mono…
    //
    // Neither request could write anything. What this gate exists to stop is the
    // crawler NAVIGATING into production or a third-party admin panel, and any
    // request that MUTATES an origin we were not pointed at. Those two are checked
    // explicitly below; everything else is the page loading what it needs.
    const navigating = isTopLevelNavigation(req);
    if (policy.allowThirdPartySubresources && !mutating && !navigating) {
      return { allow: true };
    }
    return {
      allow: false,
      rule: 'origin',
      reason: navigating
        ? `navigation to ${originOf(req.url) ?? req.url} is not on the project allowlist`
        : `${req.method.toUpperCase()} ${originOf(req.url) ?? req.url} is not on the project allowlist`,
    };
  }

  if (mutating && !policy.allowMutations) {
    return {
      allow: false,
      rule: 'method',
      reason: `${req.method.toUpperCase()} refused — this run is not flagged as mutating`,
    };
  }

  return { allow: true };
}

function schemeOf(url: string): string | null {
  const idx = url.indexOf(':');
  return idx === -1 ? null : url.slice(0, idx + 1).toLowerCase();
}
