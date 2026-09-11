#!/usr/bin/env node
/**
 * The real-browser evaluation tier.
 *
 * Serves the fixture app over plain HTTP and loads the built extension into a
 * real Chrome, so the things the deterministic tier structurally cannot see —
 * layout, trusted input, the real network path, the actual content script and
 * CDP dispatch — are exercised for real.
 *
 * It requires Playwright, which this repository does not depend on. That is a
 * deliberate omission rather than an oversight: adding it pulls a browser
 * download into every install, and whether that trade is worth making is the
 * repository owner's call, not this script's.
 *
 * So when the prerequisite is missing this exits **non-zero with setup
 * instructions**, never zero. A tier that cannot run must not report success —
 * that is the whole failure mode the evaluation exists to prevent, and it would
 * be absurd for the harness itself to commit it.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const FIXTURES = join(ROOT, 'test/evaluation/fixture-app');
const DIST = join(ROOT, 'dist');
const PORT = Number(process.env.EVAL_PORT ?? 8899);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/**
 * Serve one variant of the fixture, plus the one API route the fixtures call.
 *
 * `/api/orders` answers from `EVAL_API_STATUS` so the backend-failure scenario
 * can be driven against a real failing response rather than a stub.
 */
function serve(variant) {
  const base = join(FIXTURES, variant);
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

    if (url.pathname === '/api/orders') {
      const status = Number(process.env.EVAL_API_STATUS ?? 200);
      res.writeHead(status, { 'content-type': MIME['.json'] });
      res.end(JSON.stringify(status >= 400 ? { error: 'seeded failure' } : { id: 1 }));
      return;
    }

    const file = join(base, url.pathname === '/' ? 'save.html' : url.pathname.slice(1));
    // Refuse anything that escapes the variant directory, so a fixture path can
    // never be used to read the repository.
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
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Every prerequisite, checked before anything is launched. */
async function checkPrerequisites() {
  const missing = [];

  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    missing.push({
      what: 'Playwright',
      why: 'launches Chrome with the unpacked extension loaded',
      fix: 'npm i -D playwright && npx playwright install chromium',
    });
  }

  if (!(await exists(join(DIST, 'manifest.json')))) {
    missing.push({
      what: 'a built extension in dist/',
      why: 'the tier loads the real extension, not the source',
      fix: 'npm run build',
    });
  }

  return { missing, playwright };
}

function reportUnavailable(missing) {
  console.error('\nReal-browser evaluation: NOT RUN\n');
  console.error('This tier is unavailable, and reporting it as passing would be the');
  console.error('exact failure the evaluation exists to catch. Nothing was measured.\n');
  console.error('Missing prerequisites:\n');
  for (const m of missing) {
    console.error(`  • ${m.what} — ${m.why}`);
    console.error(`    fix: ${m.fix}\n`);
  }
  console.error('Then re-run:  npm run evaluate:browser\n');
  console.error('The deterministic tier does run here and covers the engine against');
  console.error('real HTML with page scripts executing:  npm run evaluate\n');
  console.error('What only this tier can tell you: whether an element is actually');
  console.error('visible under real layout, whether a control needs a trusted event,');
  console.error('and whether the content script and CDP dispatch work at all.\n');
}

async function main() {
  const { missing, playwright } = await checkPrerequisites();
  if (missing.length > 0) {
    reportUnavailable(missing);
    // Non-zero: unavailable is not success.
    process.exit(2);
  }

  console.log(`Real-browser evaluation — fixtures on http://localhost:${PORT}`);
  console.log(`Extension: ${DIST}\n`);

  for (const variant of ['correct', 'broken']) {
    const server = serve(variant);
    await new Promise((r) => server.listen(PORT, r));
    let context;
    try {
      // A persistent context is the only way to load an unpacked MV3 extension.
      context = await playwright.chromium.launchPersistentContext('', {
        headless: false, // MV3 service workers do not start in headless mode.
        args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
      });
      const page = await context.newPage();
      await page.goto(`http://localhost:${PORT}/save.html`);
      console.log(`  ${variant}: served and loaded — ${await page.title()}`);

      // ── Not yet implemented, and said so rather than left looking done ──
      //
      // Driving the extension end to end means opening its side panel, which
      // Playwright cannot focus directly, and stepping the panel's own UI. The
      // remaining work is listed in test/evaluation/README.md. Printing a
      // placeholder result here would be the same dishonesty this tier is
      // supposed to eliminate.
      console.log('  (scenario execution through the side panel is not implemented yet)');
    } finally {
      await context?.close();
      await new Promise((r) => server.close(r));
    }
  }

  console.error('\nReal-browser evaluation: INCOMPLETE');
  console.error('The fixture serves and the extension loads, but no scenario was');
  console.error('driven through the panel, so nothing was measured. See');
  console.error('test/evaluation/README.md for what remains.\n');
  process.exit(3);
}

main().catch((err) => {
  console.error('\nReal-browser evaluation: FAILED\n');
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
