/**
 * Runtime host-permission grants (fix.md §7.5).
 *
 * The manifest asks for nothing up front — `<all_urls>` was replaced with
 * `optional_host_permissions`, so access is requested per project, at the moment
 * it is needed. This is both a smaller blast radius and closer to what users
 * actually want: consent to test *their* app, not every site they visit.
 *
 * `chrome.permissions.request` must be called from a user gesture, so this is
 * driven from the side panel (a button click), never from the service worker.
 */
import { createLogger } from '../utils/logger';

const log = createLogger('host-permissions');

/**
 * Convert a URL into the narrowest origin pattern that still covers a crawl of
 * that app: scheme + host + `/*`. Deliberately does NOT widen to `*.host` —
 * subdomain access should be an explicit, separate grant.
 */
export function originPatternFor(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}

export function patternsFor(urls: readonly string[]): string[] {
  const set = new Set<string>();
  for (const url of urls) {
    const p = originPatternFor(url);
    if (p) set.add(p);
  }
  return [...set];
}

export async function hasPermissionFor(urls: readonly string[]): Promise<boolean> {
  const origins = patternsFor(urls);
  if (origins.length === 0) return false;
  try {
    return await chrome.permissions.contains({ origins });
  } catch (err) {
    log.warn('permissions.contains failed', err);
    return false;
  }
}

/**
 * Request access to the given URLs' origins.
 *
 * MUST be called synchronously from a user gesture — Chrome silently rejects
 * the request otherwise, which reads as "the user declined".
 */
export async function requestPermissionFor(urls: readonly string[]): Promise<boolean> {
  const origins = patternsFor(urls);
  if (origins.length === 0) return false;

  try {
    const granted = await chrome.permissions.request({ origins });
    log.info(`Host permission ${granted ? 'granted' : 'denied'} for: ${origins.join(', ')}`);
    return granted;
  } catch (err) {
    log.warn('permissions.request failed (must be called from a user gesture)', err);
    return false;
  }
}

/** Revoke access once a project is deleted — least privilege over time. */
export async function revokePermissionFor(urls: readonly string[]): Promise<void> {
  const origins = patternsFor(urls);
  if (origins.length === 0) return;
  try {
    await chrome.permissions.remove({ origins });
    log.info(`Revoked host permission for: ${origins.join(', ')}`);
  } catch (err) {
    log.debug('permissions.remove failed', err);
  }
}

export class MissingHostPermissionError extends Error {
  readonly isOperational = true;
  constructor(readonly origins: string[]) {
    super(
      `Pathfinder does not have permission to access ${origins.join(', ')}. ` +
        `Grant access for this project before running.`
    );
    this.name = 'MissingHostPermissionError';
  }
}

/** Throw unless every URL's origin is already granted. Call before a run. */
export async function assertPermissionFor(urls: readonly string[]): Promise<void> {
  if (await hasPermissionFor(urls)) return;
  throw new MissingHostPermissionError(patternsFor(urls));
}
