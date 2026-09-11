/**
 * Wiring for the real-browser tier.
 *
 * Serves the fixture, launches Chrome with the built extension loaded, and runs
 * the **same scenarios** the deterministic tier runs — only the driver changes.
 * That is what makes the two comparable: a different conclusion here is a
 * difference in what can be observed, not in what was tested.
 *
 * Kept out of `scripts/` so it is typechecked with the rest of the harness.
 */
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { PlaywrightDriver } from './playwright-driver';
import { evaluate, type DriverFactory, type EvaluationReport } from './harness';
import type { Scenario } from './scenarios';

const FIXTURE_ROOT = resolve(__dirname, 'fixture-app');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export interface FixtureServer {
  url: string;
  /** Set the status `/api/*` answers with, per scenario. */
  setApiStatus: (status: number) => void;
  close: () => Promise<void>;
}

/**
 * Serve one variant, plus the API route the fixtures call.
 *
 * The API answers from a mutable status so a scenario can drive a real failing
 * response rather than a stub — the difference this tier exists to make.
 */
export async function serveFixture(variant: 'correct' | 'broken', port = 0): Promise<FixtureServer> {
  const base = join(FIXTURE_ROOT, variant);
  let apiStatus = 200;

  const server: Server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];

    if (path.startsWith('/api/')) {
      res.writeHead(apiStatus, { 'content-type': MIME['.json'] });
      res.end(JSON.stringify(apiStatus >= 400 ? { error: 'seeded failure' } : { id: 1 }));
      return;
    }

    const file = join(base, path === '/' ? 'save.html' : path.slice(1));
    // Refuse anything escaping the variant directory, so a fixture path cannot
    // be used to read the repository.
    if (!file.startsWith(base)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('Not found');
    }
  });

  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;

  return {
    url: `http://127.0.0.1:${boundPort}`,
    setApiStatus: (status) => {
      apiStatus = status;
    },
    close: () =>
      new Promise<void>((r) => {
        // `close()` stops accepting new connections but does NOT resolve while
        // any keep-alive socket is still open — and Chrome keeps several open
        // to the fixture origin for the whole run. Measured: the scenarios
        // finished in 25s and the test then sat here until the 300s timeout,
        // with a complete report already printed. Dropping the live sockets is
        // what actually ends the server.
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
  /** Extension id, when the built extension registered a service worker. */
  extensionId?: string;
  close: () => Promise<void>;
}

/**
 * Launch Chrome with the built extension loaded.
 *
 * A persistent context is the only way to load an unpacked MV3 extension, and
 * headless mode does not start MV3 service workers — so `headless` defaults to
 * false and CI needs a display (xvfb). That is a real constraint, not an
 * oversight, and the runner says so when it cannot satisfy it.
 */
export async function launchWithExtension(distDir: string): Promise<BrowserSession> {
  const { chromium } = await import('playwright');
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${distDir}`,
      `--load-extension=${distDir}`,
      // Without these, a window that is not focused has its timers throttled
      // to roughly one second — and every fixture that reveals content on a
      // `setTimeout` then takes seconds per step. Measured: the suite sat at
      // 5s of CPU across 8 minutes of wall clock, idle-waiting on throttled
      // timers, which reads as a hang rather than as slowness.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      // The fixture is on 127.0.0.1 and the run is unattended; a first-run
      // bubble or default-browser prompt would steal focus mid-suite.
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-popup-blocking',
    ],
  });

  // The service worker appears asynchronously; its URL carries the extension id.
  // Absent is not fatal — the page scenarios do not need it — so it is reported
  // rather than waited on indefinitely.
  let extensionId: string | undefined;
  const existing = context.serviceWorkers();
  const worker =
    existing[0] ??
    (await context.waitForEvent('serviceworker', { timeout: 5000 }).catch(() => undefined));
  if (worker) extensionId = new URL(worker.url()).host;

  const page = context.pages()[0] ?? (await context.newPage());

  return {
    context,
    page,
    extensionId,
    close: async () => {
      await context.close().catch(() => undefined);
    },
  };
}

/**
 * A driver factory for the real-browser tier.
 *
 * One server per variant, started lazily and reused across a variant's repeats,
 * because a fresh Chrome per run would dominate the measured duration and tell
 * you about process startup rather than about the product.
 */
export function browserDriverFactory(session: BrowserSession): {
  factory: DriverFactory;
  cleanup: () => Promise<void>;
} {
  const servers = new Map<'correct' | 'broken', FixtureServer>();

  const factory: DriverFactory = async (variant, scenario: Scenario) => {
    let server = servers.get(variant);
    if (!server) {
      server = await serveFixture(variant);
      servers.set(variant, server);
    }

    // The scenario's own `respondTo` decides the API status. Reusing it means
    // the two tiers are driven by the same declaration rather than by two
    // separate notions of what the backend does.
    const seeded = scenario.respondTo?.('/api/orders', 'POST');
    server.setApiStatus(seeded?.status ?? 200);

    // Storage is per-origin and survives within a context, so it is cleared
    // between runs — otherwise a save from the previous repeat would satisfy
    // the next one and the scenario would pass without doing anything.
    //
    // Cleared WITHOUT navigating when the page is already on this variant's
    // origin. A full `goto` per run was the dominant cost of the whole tier:
    // 42 runs × one navigation each put the suite past a 300s timeout while the
    // scenarios themselves accounted for 25s of it. Navigation happens only on
    // the first run of a variant, or after switching variants.
    const onThisOrigin = session.page.url().startsWith(server.url);
    if (!onThisOrigin) {
      await session.page.goto(`${server.url}/save.html`, { waitUntil: 'domcontentloaded' });
    }
    await session.page
      .evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
      })
      .catch(() => undefined);

    return new PlaywrightDriver({
      page: session.page,
      baseUrl: server.url,
      defaultTimeoutMs: 3000,
    }) as unknown as Awaited<ReturnType<DriverFactory>>;
  };

  return {
    factory,
    cleanup: async () => {
      for (const server of servers.values()) await server.close();
      servers.clear();
    },
  };
}

/** Run the whole suite on the real-browser tier. */
export async function evaluateInBrowser(distDir: string): Promise<{
  report: EvaluationReport;
  extensionId?: string;
}> {
  const session = await launchWithExtension(distDir);
  const { factory, cleanup } = browserDriverFactory(session);
  try {
    const report = await evaluate({ tier: 'real-browser', driver: factory });
    return { report, extensionId: session.extensionId };
  } finally {
    // Browser first: closing it releases the sockets the fixture servers are
    // waiting on, so the server shutdown below has nothing left to wait for.
    await session.close();
    await cleanup();
  }
}

export type { Browser };
