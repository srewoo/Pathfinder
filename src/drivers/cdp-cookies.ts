/**
 * Cookie injection over CDP (fix.md §7.3).
 *
 * Replaces `chrome.cookies.set`, which is why the `cookies` permission could be
 * dropped from the manifest. `Network.setCookie` needs only the debugger
 * session we already hold for the target tab, and is scoped to that session
 * rather than the whole browser profile.
 *
 * Note the asymmetry, which is deliberate: this module can WRITE cookies from
 * an auth preset, but there is no read/`getAll` counterpart. §7.3 removes the
 * ability to borrow the user's live session at all — the capability is gone, not
 * merely unused.
 */
import type { AuthCookie } from '../storage/schemas';
import { registerCookieInjector } from '../core/cookie-port';
import { createLogger } from '../utils/logger';

const log = createLogger('cdp-cookies');

export interface CookieInjectionResult {
  injected: number;
  skippedExpired: number;
  failed: number;
}

/**
 * Inject preset-supplied cookies into the tab's session.
 *
 * `url` scopes cookies that carry no explicit domain, matching the semantics
 * callers already relied on from `chrome.cookies.set`.
 */
export async function injectCookiesViaCdp(
  tabId: number,
  url: string,
  cookies: readonly AuthCookie[]
): Promise<CookieInjectionResult> {
  const result: CookieInjectionResult = { injected: 0, skippedExpired: 0, failed: 0 };
  const nowSeconds = Date.now() / 1000;

  for (const cookie of cookies) {
    if (cookie.expirationDate !== undefined && cookie.expirationDate < nowSeconds) {
      result.skippedExpired++;
      log.debug(`Skipping expired cookie: ${cookie.name}`);
      continue;
    }

    try {
      await sendCommand(tabId, 'Network.setCookie', {
        name: cookie.name,
        value: cookie.value,
        url,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: toCdpSameSite(cookie.sameSite),
        expires: cookie.expirationDate,
      });
      result.injected++;
    } catch (err) {
      result.failed++;
      log.debug(`Failed to inject cookie ${cookie.name}`, err);
    }
  }

  log.info(
    `Injected ${result.injected}/${cookies.length} cookies for ${url}` +
      (result.skippedExpired ? ` (${result.skippedExpired} expired)` : '') +
      (result.failed ? ` (${result.failed} failed)` : '')
  );
  return result;
}

/**
 * chrome.cookies and CDP disagree on casing: `no_restriction` vs `None`,
 * `lax`/`strict` vs `Lax`/`Strict`. Mapping this wrong silently drops the
 * cookie on a cross-site request, which presents as a mysterious auth failure.
 */
function toCdpSameSite(
  sameSite: AuthCookie['sameSite']
): 'Strict' | 'Lax' | 'None' | undefined {
  switch (sameSite) {
    case 'strict':
      return 'Strict';
    case 'lax':
      return 'Lax';
    case 'no_restriction':
      return 'None';
    case 'unspecified':
    default:
      return undefined;
  }
}

function sendCommand(tabId: number, method: string, params: object): Promise<unknown> {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

// Register with the core port so `src/core` never imports this module (fix.md §2).
registerCookieInjector(injectCookiesViaCdp);
