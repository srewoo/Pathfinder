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
   * Third-party subresources (fonts, analytics, CDN images) are usually
   * harmless and blocking them breaks page rendering, which produces false
   * positives. Allowed by default, and only ever for non-mutating verbs.
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
  /** CDP resource type, when known. Used for the subresource exemption. */
  resourceType?: string;
}

const SUBRESOURCE_TYPES = new Set([
  'Image', 'Font', 'Stylesheet', 'Media', 'Manifest', 'Other',
]);

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

  const onAllowlist = isOriginAllowed(req.url, policy.allowedOrigins);
  const mutating = isMutating(req.method);

  if (!onAllowlist) {
    // Passive third-party subresources may load, but never with a mutating verb.
    const isSubresource = req.resourceType ? SUBRESOURCE_TYPES.has(req.resourceType) : false;
    if (policy.allowThirdPartySubresources && isSubresource && !mutating) {
      return { allow: true };
    }
    return {
      allow: false,
      rule: 'origin',
      reason: `origin ${originOf(req.url) ?? req.url} is not on the project allowlist`,
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
