/**
 * `Locator` → Playwright locator expression.
 *
 * The locator ladder maps onto Playwright's own API one rung at a time, which is
 * why this transpiler needs no model: `testid` → `getByTestId`, `semantic` →
 * `getByRole`, `structural` → `locator`. Emission walks the tiers in durability
 * order starting at `preferredTier`, so a test exported today keeps the
 * strongest identifier it was captured with.
 *
 * Failure is a value, never a silently-wrong string. A locator with nothing
 * emittable returns `unsupported` and the caller reports it to the user —
 * emitting a comment in its place would produce a spec file that passes while
 * testing nothing.
 */
import type { AriaRole, Locator, LocatorTier } from '../locator';

export type LocatorEmit = { expr: string } | { unsupported: string };

/**
 * Roles Playwright's `getByRole` does not accept. `generic` is a real ARIA role
 * and is in our own enum, but passing it to Playwright throws at run time, so it
 * must fall through to a lower tier at emit time rather than at test time.
 */
const NON_PLAYWRIGHT_ROLES: ReadonlySet<string> = new Set(['generic']);

/** Single-quote a value for embedding in generated TypeScript. */
export function quote(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `'${escaped}'`;
}

const TIER_ORDER: readonly LocatorTier[] = ['testid', 'semantic', 'structural'];

/** Tiers to try, best-first, starting from the locator's preferred tier. */
function tiersToTry(loc: Locator): LocatorTier[] {
  const start = TIER_ORDER.indexOf(loc.preferredTier);
  const from = start === -1 ? 0 : start;
  return [...TIER_ORDER.slice(from), ...TIER_ORDER.slice(0, from)];
}

function emitRole(role: AriaRole, name: string, exact: boolean | undefined): string {
  const opts = [`name: ${quote(name)}`];
  if (exact) opts.push('exact: true');
  return `getByRole(${quote(role)}, { ${opts.join(', ')} })`;
}

export function emitLocator(loc: Locator, root = 'page'): LocatorEmit {
  for (const tier of tiersToTry(loc)) {
    if (tier === 'testid' && loc.testid) {
      return { expr: `${root}.getByTestId(${quote(loc.testid)})` };
    }
    if (tier === 'semantic' && loc.semantic && !NON_PLAYWRIGHT_ROLES.has(loc.semantic.role)) {
      const { role, name, exact, scope } = loc.semantic;
      let base = root;
      if (scope) {
        const scoped = emitLocator(scope, root);
        if ('unsupported' in scoped) return scoped;
        base = scoped.expr;
      }
      return { expr: `${base}.${emitRole(role, name, exact)}` };
    }
    if (tier === 'structural' && loc.structural?.css) {
      return { expr: `${root}.locator(${quote(loc.structural.css)})` };
    }
  }
  return { unsupported: 'locator has no emittable tier' };
}
