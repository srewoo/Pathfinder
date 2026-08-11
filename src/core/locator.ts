/**
 * Locator ladder (fix.md §5).
 *
 * Locators are STRUCTURED DATA, never serialized selector strings. Resolution
 * walks three tiers in order of durability:
 *
 *   1. testid     — `data-testid`. Survives everything. Preferred.
 *   2. semantic   — role + accessible name (+ optional scope). Survives CSS
 *                   refactors, class renames and DOM re-nesting, which are
 *                   exactly the changes that break CSS selectors.
 *   3. structural — CSS + a DOM fingerprint. Brittle by construction; healing
 *                   (dom-similarity) only ever applies at this tier.
 *
 * A locator carries ALL tiers it was captured with, so resolution can degrade
 * without regenerating anything. `preferredTier` records the best tier that was
 * available at capture time — the input to the testability report.
 */
import { z } from 'zod';

// ── Types ───────────────────────────────────────────────────────────────────

export const ARIA_ROLES = [
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox',
  'option', 'tab', 'tabpanel', 'menuitem', 'heading', 'img', 'dialog', 'alert',
  'table', 'row', 'cell', 'switch', 'slider', 'searchbox', 'spinbutton',
  'progressbar', 'tooltip', 'menu', 'navigation', 'form', 'region', 'generic',
] as const;

export type AriaRole = (typeof ARIA_ROLES)[number];

export const DomFingerprintSchema = z.object({
  /** Tag name, lowercased. */
  tag: z.string(),
  /** Stable-looking attributes only — never generated/hashed class names. */
  attrs: z.record(z.string()),
  /** Trimmed, collapsed text content, capped. */
  text: z.string().max(200),
  /** Depth from document root — cheap structural discriminator. */
  depth: z.number().int().nonnegative(),
  /** Index among same-tag siblings. */
  siblingIndex: z.number().int().nonnegative(),
});

export type DomFingerprint = z.infer<typeof DomFingerprintSchema>;

export const LocatorTierSchema = z.enum(['testid', 'semantic', 'structural']);
export type LocatorTier = z.infer<typeof LocatorTierSchema>;

/**
 * Recursive by way of `scope` — a semantic locator may be scoped by another
 * locator ("the Save button *within* the Billing form"). zod needs the explicit
 * lazy type annotation for the self-reference.
 */
export type Locator = {
  testid?: string;
  semantic?: { role: AriaRole; name: string; exact?: boolean; scope?: Locator };
  structural?: { css: string; fingerprint?: DomFingerprint };
  preferredTier: LocatorTier;
  /** Human-readable, for logs and reports. Never used for resolution. */
  label?: string;
};

export const LocatorSchema: z.ZodType<Locator> = z.lazy(() =>
  z
    .object({
      testid: z.string().min(1).optional(),
      semantic: z
        .object({
          role: z.enum(ARIA_ROLES),
          name: z.string(),
          exact: z.boolean().optional(),
          scope: LocatorSchema.optional(),
        })
        .optional(),
      structural: z
        .object({
          css: z.string().min(1),
          fingerprint: DomFingerprintSchema.optional(),
        })
        .optional(),
      preferredTier: LocatorTierSchema,
      label: z.string().optional(),
    })
    .refine(
      (l) => Boolean(l.testid || l.semantic || l.structural),
      { message: 'Locator must define at least one tier' }
    )
);

// ── Construction ────────────────────────────────────────────────────────────

/**
 * Best tier actually present on a locator, independent of `preferredTier`.
 * Resolution order is fixed: testid → semantic → structural.
 */
export function bestTier(loc: Locator): LocatorTier {
  if (loc.testid) return 'testid';
  if (loc.semantic) return 'semantic';
  return 'structural';
}

/** Tiers present on this locator, in resolution order. */
export function tiersOf(loc: Locator): LocatorTier[] {
  const tiers: LocatorTier[] = [];
  if (loc.testid) tiers.push('testid');
  if (loc.semantic) tiers.push('semantic');
  if (loc.structural) tiers.push('structural');
  return tiers;
}

/**
 * Wrap a bare CSS selector as a structural-only locator.
 *
 * This is the compatibility shim for legacy `ExecutionStep.selector` strings.
 * Every call site is a place that has not yet been migrated to a real locator,
 * so it is deliberately easy to grep for.
 */
export function fromCss(css: string, label?: string): Locator {
  return { structural: { css }, preferredTier: 'structural', label: label ?? css };
}

export function fromTestId(testid: string, label?: string): Locator {
  return { testid, preferredTier: 'testid', label: label ?? `[data-testid=${testid}]` };
}

export function fromRole(
  role: AriaRole,
  name: string,
  opts: { exact?: boolean; scope?: Locator; label?: string } = {}
): Locator {
  return {
    semantic: { role, name, exact: opts.exact, scope: opts.scope },
    preferredTier: 'semantic',
    label: opts.label ?? `${role}("${name}")`,
  };
}

// ── Description ─────────────────────────────────────────────────────────────

/** Stable human-readable description. For logs, reports and error messages. */
export function describeLocator(loc: Locator): string {
  if (loc.label) return loc.label;
  if (loc.testid) return `[data-testid="${loc.testid}"]`;
  if (loc.semantic) {
    const base = `${loc.semantic.role}("${loc.semantic.name}")`;
    return loc.semantic.scope ? `${base} in ${describeLocator(loc.semantic.scope)}` : base;
  }
  return loc.structural?.css ?? '<empty locator>';
}

/**
 * Stable identity key for a locator, used to dedupe and to correlate heal
 * events across runs. Deliberately excludes `label` and the fingerprint, so
 * cosmetic recapture does not produce a new key.
 */
export function locatorKey(loc: Locator): string {
  if (loc.testid) return `testid:${loc.testid}`;
  if (loc.semantic) {
    const scope = loc.semantic.scope ? `@${locatorKey(loc.semantic.scope)}` : '';
    return `semantic:${loc.semantic.role}:${loc.semantic.name}${scope}`;
  }
  return `css:${loc.structural?.css ?? ''}`;
}

// ── Testability ─────────────────────────────────────────────────────────────

/**
 * A locator that can only be resolved structurally is a testability gap: the
 * app gave us nothing durable to hold onto. §5 turns these into a report rather
 * than swallowing them.
 */
export function isTestabilityGap(loc: Locator): boolean {
  return bestTier(loc) === 'structural';
}
