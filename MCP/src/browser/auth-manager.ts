import type { BrowserContext } from 'playwright';
import type { AuthCookie } from '../storage/schemas.js';
import { getContext } from './browser-manager.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('auth');

export async function injectCookies(cookies: AuthCookie[], url: string): Promise<number> {
  const ctx = await getContext();
  let injected = 0;
  for (const cookie of cookies) {
    if (cookie.expirationDate && cookie.expirationDate * 1000 < Date.now()) continue;
    try {
      await ctx.addCookies([{
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite === 'no_restriction' ? 'None' : cookie.sameSite === 'lax' ? 'Lax' : 'Strict',
        expires: cookie.expirationDate,
      }]);
      injected++;
    } catch (err) {
      log.debug(`Failed to inject cookie ${cookie.name}`, err);
    }
  }
  log.info(`Injected ${injected}/${cookies.length} cookies for ${url}`);
  return injected;
}

export async function captureCookies(url: string): Promise<AuthCookie[]> {
  const ctx = await getContext();
  const cookies = await ctx.cookies(url);
  return cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite === 'None' ? 'no_restriction' as const : c.sameSite === 'Lax' ? 'lax' as const : 'strict' as const,
    expirationDate: c.expires > 0 ? c.expires : undefined,
  }));
}
