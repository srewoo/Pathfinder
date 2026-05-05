/**
 * URL resolution for environment-agnostic test execution.
 *
 * Exploration data is stored with absolute URLs (e.g. https://staging.example.com/courses/123).
 * When running tests against a DIFFERENT environment, all URLs in the graph, flows,
 * and test plans are rewritten to the target origin.
 */

export function resolveUrl(path: string, targetOrigin: string): string {
  return new URL(path, targetOrigin).toString();
}

export function extractPath(absoluteUrl: string): string {
  const u = new URL(absoluteUrl);
  return u.pathname + u.search;
}

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    let path = u.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    return u.origin + path;
  } catch {
    return url;
  }
}

/**
 * Rewrite an absolute URL from one origin to another.
 * e.g. rewriteOrigin("https://staging.app.com/courses/123", "https://prod.app.com")
 *   => "https://prod.app.com/courses/123"
 */
export function rewriteOrigin(absoluteUrl: string, targetOrigin: string): string {
  try {
    const u = new URL(absoluteUrl);
    const target = new URL(targetOrigin);
    u.protocol = target.protocol;
    u.host = target.host;
    u.port = target.port;
    return u.toString();
  } catch {
    return absoluteUrl;
  }
}

/**
 * Detect the origin from a graph's nodes. Returns the most common origin.
 */
export function detectGraphOrigin(nodeUrls: string[]): string | undefined {
  const origins = new Map<string, number>();
  for (const url of nodeUrls) {
    try {
      const origin = new URL(url).origin;
      origins.set(origin, (origins.get(origin) ?? 0) + 1);
    } catch { /* skip invalid */ }
  }
  if (origins.size === 0) return undefined;
  return [...origins.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Rewrite all URLs in a test case's steps and startUrl from source origin to target origin.
 */
export function rewriteTestCaseUrls(
  steps: string[] | undefined,
  startUrl: string | undefined,
  sourceOrigin: string,
  targetOrigin: string
): { steps: string[] | undefined; startUrl: string | undefined } {
  if (sourceOrigin === targetOrigin) return { steps, startUrl };

  const rewrittenStartUrl = startUrl ? rewriteOrigin(startUrl, targetOrigin) : undefined;
  const rewrittenSteps = steps?.map((step) => {
    // Rewrite any URLs embedded in step text
    return step.replace(new RegExp(escapeRegex(sourceOrigin), 'g'), targetOrigin);
  });

  return { steps: rewrittenSteps, startUrl: rewrittenStartUrl };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
