/**
 * Resolve a run's origin policy (fix.md §7).
 *
 * There is no `Project` entity in the schema, so the allowlist is derived from
 * the thing every run already has: its start URL. That keeps the safety model
 * from waiting on a data-model change it does not need.
 *
 * Default posture is STRICT — the start URL's origin only, mutations blocked.
 * A too-narrow allowlist is a self-announcing failure: the mutation ledger
 * reports "N requests refused (M off-allowlist)" in the run summary, so the fix
 * is obvious. A too-wide one fails silently by letting a run touch production.
 * Given that asymmetry, strict is the correct default.
 */
import type { OriginPolicy } from './origin-policy';
import { createPolicy, originOf } from './origin-policy';

export interface PolicyInput {
  /** The run's entry point. Its origin becomes the allowlist. */
  startUrl?: string;
  /**
   * Extra origins the user explicitly allowed — a separate API host, a CDN that
   * must be reachable, a sibling subdomain. Opt-in, never inferred.
   */
  extraOrigins?: readonly string[];
  /**
   * True only when the caller explicitly asked to mutate (e.g. `submitForms`).
   * Mirrors the read-only-by-default stance the explorer already takes.
   */
  allowMutations?: boolean;
  /** Additional URLs the run is known to visit (e.g. resolved flow start URLs). */
  additionalUrls?: readonly string[];
}

/**
 * Build the policy for a run.
 *
 * A missing/unparseable start URL yields an EMPTY allowlist, which refuses
 * everything. That is deliberate: a run whose target we cannot identify is a run
 * we cannot scope, and failing closed beats silently allowing the open internet.
 */
export function resolvePolicy(input: PolicyInput): OriginPolicy {
  const origins = new Set<string>();

  for (const url of [input.startUrl, ...(input.additionalUrls ?? [])]) {
    if (!url) continue;
    const origin = originOf(url);
    if (origin) origins.add(origin);
  }

  for (const extra of input.extraOrigins ?? []) {
    const trimmed = extra.trim();
    if (trimmed) origins.add(trimmed);
  }

  return createPolicy({
    allowedOrigins: [...origins],
    allowMutations: input.allowMutations === true,
    // Passive third-party subresources stay allowed: blocking fonts and CDN
    // images breaks rendering, and a broken render manufactures false positives.
    allowThirdPartySubresources: true,
  });
}

/** True when the policy cannot allow anything — worth warning about loudly. */
export function isPolicyEmpty(policy: OriginPolicy): boolean {
  return policy.allowedOrigins.length === 0;
}

/** One-line description for logs and the run summary. */
export function describePolicy(policy: OriginPolicy): string {
  if (isPolicyEmpty(policy)) {
    return 'DENY ALL (no start URL could be resolved — every request will be refused)';
  }
  return (
    `${policy.allowedOrigins.join(', ')} · ` +
    `mutations ${policy.allowMutations ? 'ALLOWED' : 'blocked'}`
  );
}
