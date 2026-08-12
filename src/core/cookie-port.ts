/**
 * Cookie-injection port (fix.md §2, §7.3).
 *
 * `core/executor/auth-manager.ts` needs to seed preset cookies into a session,
 * but the mechanism (CDP `Network.setCookie`) belongs to the driver layer. Core
 * declares the capability here; `src/drivers/cdp-cookies.ts` provides it.
 *
 * Note there is deliberately no READ counterpart. §7.3 removed the ability to
 * borrow the user's live session, and the port shape enforces that: nothing in
 * core can even ask for the browser's cookies.
 */
import type { AuthCookie } from '../storage/schemas';

export interface CookieInjectionResult {
  injected: number;
  skippedExpired: number;
  failed: number;
}

export type CookieInjectorFn = (
  tabId: number,
  url: string,
  cookies: readonly AuthCookie[]
) => Promise<CookieInjectionResult>;

let injector: CookieInjectorFn | null = null;

export function registerCookieInjector(fn: CookieInjectorFn): void {
  injector = fn;
}

/**
 * Inject preset cookies into the tab's session.
 *
 * Returns a zero result when no injector is registered rather than throwing:
 * auth setup is best-effort by design (a preset may simply have no cookies), and
 * the caller already handles a zero-injection outcome by falling through to a
 * real login.
 */
export async function injectCookies(
  tabId: number,
  url: string,
  cookies: readonly AuthCookie[]
): Promise<CookieInjectionResult> {
  if (!injector) return { injected: 0, skippedExpired: 0, failed: cookies.length };
  return injector(tabId, url, cookies);
}
