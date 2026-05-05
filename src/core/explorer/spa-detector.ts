/**
 * SPA Route Detector
 *
 * Discovers client-side routes from the current page by inspecting:
 * - Next.js __NEXT_DATA__ and __BUILD_MANIFEST globals
 * - Vue Router / Nuxt __NUXT__ globals
 * - Navigation DOM elements (nav, role=navigation, role=menubar)
 * - All same-origin <a href> links
 *
 * Returns discovered route paths for the explorer to enqueue.
 */

import { sendToContentScript } from '../../messaging/messenger';
import { createLogger } from '../../utils/logger';

const log = createLogger('spa-detector');

/**
 * Detect SPA routes from the current page. Returns absolute URLs.
 * Falls back to an empty array on any error — non-fatal.
 */
export async function detectSPARoutes(tabId: number, origin: string): Promise<string[]> {
  try {
    const response = await sendToContentScript<{
      payload: { framework: string; routes: string[] };
    }>(tabId, { type: 'DETECT_SPA_ROUTES' });

    const result = response?.payload;
    if (!result || result.routes.length === 0) return [];

    log.info(`SPA detector (${result.framework}): ${result.routes.length} routes found`);

    return result.routes
      .map((route) => {
        try {
          const url = new URL(route, origin).href;
          return url.startsWith(origin) ? url : null;
        } catch {
          return null;
        }
      })
      .filter((url): url is string => url !== null)
      .slice(0, 150); // cap — the BFS queue handles depth limiting
  } catch {
    return [];
  }
}
