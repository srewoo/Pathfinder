/**
 * Which controls are unsafe for an autonomous crawler to click.
 *
 * The previous rule read `element.text` against a word list. Measured against a
 * real app, that rule caught **0 of 50** delete buttons on a single page, because
 * the markup is:
 *
 *   <button class="oxd-icon-button"><i class="oxd-icon bi-trash"></i></button>
 *
 * No text, no aria-label, no title. 103 of 111 buttons on that page were nameless.
 * A crawler running with the default "skip dangerous things" posture would have
 * clicked every delete on the page and believed it was being careful.
 *
 * So the classifier reads every signal that exists, in order of reliability:
 *   1. accessible name (text, aria-label, title, name)
 *   2. icon class tokens (`bi-trash`, `fa-times`, `mdi-delete`)
 *   3. structural position — a nameless control inside a data row
 *
 * (3) is precautionary rather than evidence: an unnamed button in a table row is
 * usually edit or delete, and we cannot tell which. It is reported separately from
 * (1) and (2) so the coverage it costs is visible rather than hidden inside a
 * "dangerous" bucket.
 */
import type { InteractiveElement } from '../../storage/schemas';

/**
 * Words that end the session.
 *
 * Kept separate from the destructive list because the consequence is different in
 * kind, not just degree. A delete destroys one record; a logout invalidates every
 * page that follows it — the crawler lands on the login screen and maps THAT,
 * while the run keeps reporting pages "explored". One click can turn an entire
 * crawl into a map of a login form.
 *
 * That is why these are refused even under `includeDangerous`. A user who opts
 * into destructive exploration wants to exercise delete flows; nobody wants to be
 * logged out three pages in.
 *
 * Deliberately excludes ambiguous words. Bare "exit" is usually "exit full
 * screen"; "leave" is usually "leave feedback"; "sign off" in an HR app often
 * means approving a document, not ending a session.
 */
const SESSION_ENDING_WORDS = [
  'logout', 'log out', 'log-out', 'logoff', 'log off',
  'signout', 'sign out', 'sign-out',
  'end session', 'close session', 'terminate session', 'kill session',
  'revoke session', 'switch account', 'switch user', 'change user',
  'lock screen',
];

/** Icons that depict leaving. */
const SESSION_ENDING_ICON_RX =
  /(^|[-_])(logout|log-?out|sign-?out|signout|box-arrow-right|box-arrow-left|power|power-?off|door|exit)([-_]|$)/i;

/**
 * URLs that end a session when visited.
 *
 * The strongest signal available and the only one that survives an unlabelled
 * control: a link to `/logout` ends the session whether its text says so, says
 * nothing, or is an icon. This also guards NAVIGATION — the crawler enqueues
 * `<a href>` targets without clicking them, so a logout link would otherwise be
 * walked into directly from the frontier.
 *
 * The trailing separator class excludes `-` and `_` on purpose: allowing them made
 * `/blog/logout-best-practices` and `/products/signout-widget-pro` match, which
 * would silently drop ordinary content pages from the crawl. Hyphenated spellings
 * of the action itself are handled inside the alternation (`log[-_]?out`).
 */
const SESSION_ENDING_URL_RX =
  /(^|[/?#&=._-])(log[-_]?out|sign[-_]?out|signout|logoff|log[-_]?off|end[-_]?session|destroy[-_]?session|close[-_]?session|saml\/logout|shibboleth\.sso\/logout)($|[/?#&=.])/i;

/** True when visiting this URL would end the session. */
export function isSessionEndingUrl(url: string): boolean {
  return SESSION_ENDING_URL_RX.test(url);
}

/** Words that name a destructive action. */
const DESTRUCTIVE_WORDS = [
  'delete', 'remove', 'destroy', 'purge', 'wipe', 'erase', 'discard',
  'cancel subscription', 'close account', 'deactivate', 'terminate',
  'revoke', 'reset password', 'unpublish', 'archive',
];

/**
 * Icon tokens that mean destruction.
 *
 * Deliberately excludes the ambiguous ones. `x`/`times`/`close` most often
 * dismisses a dialog — treating those as destructive would block the crawler from
 * closing its own modals and stall exploration on the first popup.
 */
const DESTRUCTIVE_ICON_RX =
  /(^|[-_])(trash|trash-?fill|trash-?can|bin|delete|remove-?circle|eraser|power|logout|log-?out|sign-?out|box-arrow-right|ban|slash-circle)([-_]|$)/i;

/** Icon tokens that are known-safe, so they never fall into the unnamed bucket. */
const SAFE_ICON_RX =
  /(^|[-_])(pencil|pen|edit|eye|view|info|question|search|filter|sort|download|export|print|plus|add|chevron|caret|arrow|calendar|clock|copy|link|share|bookmark|star|bell|gear|cog|settings|refresh|upload|menu|grid|list|home|user|people|person)([-_]|$)/i;

export type ControlRisk =
  /** Safe to click. */
  | { risk: 'safe' }
  /**
   * Ends the session. NEVER clickable, including under `includeDangerous` —
   * everything after it would be a map of the login page.
   */
  | { risk: 'session-ending'; reason: string }
  /** Names or depicts a destructive action. */
  | { risk: 'destructive'; reason: string }
  /**
   * No accessible name and no recognisable icon, sitting in a data row. Could be
   * anything, including delete.
   */
  | { risk: 'unidentified'; reason: string };

/** Everything that could serve as an accessible name, joined for matching. */
export function accessibleNameOf(el: InteractiveElement): string {
  return [el.ariaLabel, el.text, el.name, el.testId].filter(Boolean).join(' ').trim();
}

export function classifyControl(el: InteractiveElement): ControlRisk {
  const name = accessibleNameOf(el).toLowerCase();
  const icons = el.iconClasses ?? [];

  // Session-ending is checked FIRST so the reason names the real consequence.
  // "Sign out" would otherwise be reported as merely destructive, and would be
  // clickable the moment someone enabled destructive exploration.
  for (const word of SESSION_ENDING_WORDS) {
    if (new RegExp(`\\b${word.replace(/ /g, '[\\s-]*')}\\b`, 'i').test(name)) {
      return { risk: 'session-ending', reason: `"${name.slice(0, 40)}" ends the session` };
    }
  }
  if (el.href && isSessionEndingUrl(el.href)) {
    return { risk: 'session-ending', reason: `links to ${el.href.slice(0, 60)}, which ends the session` };
  }
  for (const icon of icons) {
    if (SESSION_ENDING_ICON_RX.test(icon)) {
      return { risk: 'session-ending', reason: `icon "${icon}" depicts leaving/signing out` };
    }
  }

  for (const word of DESTRUCTIVE_WORDS) {
    // Word-boundary match so "undelete" or "removal notice" do not trip it.
    if (new RegExp(`\\b${word.replace(/ /g, '\\s+')}\\b`, 'i').test(name)) {
      return { risk: 'destructive', reason: `label "${name.slice(0, 40)}" names a destructive action` };
    }
  }

  for (const icon of icons) {
    if (DESTRUCTIVE_ICON_RX.test(icon)) {
      return { risk: 'destructive', reason: `icon "${icon}" depicts a destructive action` };
    }
  }

  // Named, or carrying a recognisable icon → identified and not destructive.
  if (name.length > 0) return { risk: 'safe' };
  if (icons.some((i) => SAFE_ICON_RX.test(i))) return { risk: 'safe' };

  // Nameless and unrecognised. Inside a data row this is very likely a row
  // action, so it is withheld by default; anywhere else it is ordinary chrome.
  if (el.inDataRegion) {
    const informative = mostSpecificIcon(icons);
    return {
      risk: 'unidentified',
      reason: informative
        ? `unnamed row control with unrecognised icon "${informative}"`
        : 'unnamed row control with no icon to identify it',
    };
  }
  return { risk: 'safe' };
}

/** Base classes that name the icon LIBRARY rather than the icon. */
const GENERIC_ICON_TOKENS = new Set([
  'icon', 'oxd-icon', 'material-icons', 'fa', 'fas', 'far', 'fal', 'fab', 'bi', 'mdi', 'glyphicon',
]);

/**
 * The token that actually identifies the icon.
 *
 * `['oxd-icon', 'bi-three-dots']` should report `bi-three-dots`; naming the
 * library tells a reader nothing about what the control does, and every such
 * message would read identically.
 */
export function mostSpecificIcon(icons: readonly string[]): string | null {
  const specific = icons.filter((i) => !GENERIC_ICON_TOKENS.has(i.toLowerCase()));
  return specific[0] ?? icons[0] ?? null;
}

/**
 * May the crawler click this?
 *
 * `includeDangerous` opens the destructive and unidentified tiers — it does NOT
 * open session-ending controls. That is not an oversight to be tidied up later:
 * opting into delete flows is a decision about data, while being logged out
 * silently invalidates every page the run visits afterwards, including the
 * destructive flows the flag was enabled to exercise.
 */
export function isSafeToClick(el: InteractiveElement, includeDangerous = false): boolean {
  const verdict = classifyControl(el);
  if (verdict.risk === 'session-ending') return false;
  if (includeDangerous) return true;
  return verdict.risk === 'safe';
}
