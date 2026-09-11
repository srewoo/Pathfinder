/**
 * IR assertion → Playwright `expect()` line.
 *
 * Split from the emitter to keep both files focused: this one owns the mapping
 * from every `AssertKind` to its matcher, and the emitter owns file assembly.
 *
 * Kinds with no static equivalent are returned as a drop reason rather than
 * emitted as a comment. A spec file that looks complete but asserts less than
 * the test it came from is worse than one the user knows is partial.
 */
import type { Assertion } from '../ir/test-ir';
import { emitLocator, quote } from './playwright-locator';

export type AssertionEmit = { line: string } | { dropped: string };

/**
 * Assertion kinds that need request interception rather than a page matcher.
 * Pathfinder evaluates these against captured CDP network traffic, which a
 * plain spec file has no equivalent for.
 */
const NETWORK_KINDS: ReadonlySet<string> = new Set([
  'api_called',
  'api_not_called',
  'api_status',
]);

/** Numeric expectation, defaulting to 0 rather than emitting `NaN`. */
function count(expected: string | undefined): number {
  const parsed = Number(expected);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function emitAssertion(a: Assertion): AssertionEmit {
  if (NETWORK_KINDS.has(a.kind)) {
    return {
      dropped:
        `assertion ${a.order} (${a.kind}) "${a.description}": network assertions need ` +
        `request interception and are not emitted — verify this in Pathfinder, or add a ` +
        `page.route() handler by hand`,
    };
  }

  // `url` asserts about the page, not an element, so it needs no locator.
  if (a.kind === 'url') {
    return { line: `await expect(page).toHaveURL(${quote(a.expected ?? '')});` };
  }

  if (!a.locator) {
    return { dropped: `assertion ${a.order} (${a.kind}) "${a.description}": no locator` };
  }
  const emitted = emitLocator(a.locator);
  if ('unsupported' in emitted) {
    return { dropped: `assertion ${a.order} (${a.kind}) "${a.description}": ${emitted.unsupported}` };
  }

  const subject = `expect(${emitted.expr})`;
  const expected = a.expected ?? '';

  switch (a.kind) {
    case 'visible':
      return { line: `await ${subject}.toBeVisible();` };
    case 'not_visible':
      return { line: `await ${subject}.not.toBeVisible();` };
    case 'exists':
      return { line: `await ${subject}.toBeAttached();` };
    case 'not_exists':
      return { line: `await ${subject}.not.toBeAttached();` };
    case 'text':
      return { line: `await ${subject}.toContainText(${quote(expected)});` };
    case 'not_text':
      return { line: `await ${subject}.not.toContainText(${quote(expected)});` };
    case 'value':
      return { line: `await ${subject}.toHaveValue(${quote(expected)});` };
    case 'attribute':
      return {
        line: `await ${subject}.toHaveAttribute(${quote(a.attribute ?? '')}, ${quote(expected)});`,
      };
    case 'enabled':
      return { line: `await ${subject}.toBeEnabled();` };
    case 'disabled':
      return { line: `await ${subject}.toBeDisabled();` };
    case 'exact_count':
      return { line: `await ${subject}.toHaveCount(${count(expected)});` };
    // `count` is an at-least assertion in the IR, which has no direct matcher.
    case 'count':
      return {
        line: `expect(await ${emitted.expr}.count()).toBeGreaterThanOrEqual(${count(expected)});`,
      };
    default:
      return { dropped: `assertion ${a.order}: unsupported kind "${String(a.kind)}"` };
  }
}
