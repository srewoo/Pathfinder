import { writeFile } from 'fs/promises';
import { chromium } from 'playwright';
import { createLogger } from '../../utils/logger.js';
import { withErrorHandling } from './_error-wrapper.js';

const log = createLogger('capture-auth');

/**
 * Open a visible browser window so the user can log in manually.
 * Once login is detected (URL changes to wait_for_url, or the timeout elapses),
 * the full Playwright storageState (cookies + localStorage) is saved to save_path.
 */
export async function handleCaptureAuth(args: {
  url: string;
  save_path: string;
  wait_for_url?: string;
  timeout_seconds?: number;
}) {
  return withErrorHandling(async () => {
    const { url, save_path, wait_for_url, timeout_seconds = 120 } = args;

    log.info(`Opening browser for manual login at ${url}`);

    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      if (wait_for_url) {
        log.info(`Waiting for URL to match "${wait_for_url}" (timeout: ${timeout_seconds}s)`);
        await page.waitForURL((u) => u.href.includes(wait_for_url), {
          timeout: timeout_seconds * 1000,
        });
      } else {
        // No success URL provided — wait for any navigation away from the login page
        log.info(`Waiting ${timeout_seconds}s for login to complete...`);
        const startUrl = page.url();
        const deadline = Date.now() + timeout_seconds * 1000;
        while (Date.now() < deadline) {
          await page.waitForTimeout(1000);
          if (page.url() !== startUrl) {
            break;
          }
        }
      }

      const state = await context.storageState();
      await writeFile(save_path, JSON.stringify(state, null, 2), 'utf-8');

      const cookieCount = state.cookies.length;
      const originCount = state.origins.length;
      log.info(`Auth captured: ${cookieCount} cookies, ${originCount} origins → ${save_path}`);

      return {
        content: [{
          type: 'text' as const,
          text: [
            `Auth session captured successfully.`,
            `  Cookies: ${cookieCount}`,
            `  Origins with localStorage: ${originCount}`,
            `  Saved to: ${save_path}`,
            ``,
            `Use this in future runs:`,
            `  run_one_liners: storage_state_path="${save_path}"`,
            `  run_csv:        storage_state_path="${save_path}"`,
          ].join('\n'),
        }],
      };
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }, 'capture_auth');
}

/**
 * Read cookies from the user's existing Chrome/Chromium profile and convert
 * them to a Playwright storageState JSON file — no re-login needed.
 *
 * Chrome stores cookies in a SQLite database at a known OS path.
 * On macOS the cookie values are AES-128-CBC encrypted with a key stored in
 * the system Keychain under "Chrome Safe Storage". We attempt a best-effort
 * read: cookies with encrypted values are skipped (marked as such in the log).
 *
 * Supports: Google Chrome, Chromium, Brave, Arc on macOS + Windows + Linux.
 */
export async function handleImportChromeCookies(args: {
  domain_filter?: string;
  save_path: string;
  profile?: string;
}) {
  return withErrorHandling(async () => {
    const { domain_filter, save_path, profile = 'Default' } = args;

    // Locate Chrome cookie DB based on OS
    const os = process.platform;
    let cookieDbPath: string;

    if (os === 'darwin') {
      const home = process.env.HOME ?? '';
      const candidates = [
        `${home}/Library/Application Support/Google/Chrome/${profile}/Cookies`,
        `${home}/Library/Application Support/BraveSoftware/Brave-Browser/${profile}/Cookies`,
        `${home}/Library/Application Support/Arc/User Data/${profile}/Cookies`,
        `${home}/Library/Application Support/Chromium/${profile}/Cookies`,
      ];
      const { access } = await import('fs/promises');
      let found: string | undefined;
      for (const c of candidates) {
        try { await access(c); found = c; break; } catch {}
      }
      if (!found) {
        return {
          content: [{ type: 'text' as const, text: `Chrome cookie database not found. Tried:\n${candidates.join('\n')}\n\nMake sure Chrome is installed and has been opened at least once.` }],
          isError: true,
        };
      }
      cookieDbPath = found;
    } else if (os === 'win32') {
      const appData = process.env.LOCALAPPDATA ?? '';
      cookieDbPath = `${appData}\\Google\\Chrome\\User Data\\${profile}\\Network\\Cookies`;
    } else {
      const home = process.env.HOME ?? '';
      cookieDbPath = `${home}/.config/google-chrome/${profile}/Cookies`;
    }

    log.info(`Reading Chrome cookies from ${cookieDbPath}`);

    const { copyFile, unlink } = await import('fs/promises');
    const tmpPath = `${save_path}.chrome-cookies.tmp`;
    await copyFile(cookieDbPath, tmpPath);

    let cookies: any[] = [];
    let skippedEncrypted = 0;

    try {
      const Database = await import('better-sqlite3' as any).then((m: any) => m.default).catch(() => null);
      if (!Database) {
        await unlink(tmpPath).catch(() => {});
        return {
          content: [{
            type: 'text' as const,
            text: [
              `The chrome_cookies import requires better-sqlite3, which is not installed.`,
              ``,
              `Install it with:  npm install better-sqlite3`,
              ``,
              `Alternatively, use capture_auth to log in via browser and save the session automatically.`,
            ].join('\n'),
          }],
          isError: true,
        };
      }

      const db = new Database(tmpPath, { readonly: true });
      const rows = db.prepare(`
        SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite
        FROM cookies
        ${domain_filter ? `WHERE host_key LIKE ?` : ''}
        ORDER BY host_key
      `).all(...(domain_filter ? [`%${domain_filter}%`] : [])) as any[];

      db.close();

      for (const row of rows) {
        const hasValue = row.value && row.value.length > 0;
        const isEncrypted = !hasValue && row.encrypted_value && row.encrypted_value.length > 0;

        if (isEncrypted) {
          skippedEncrypted++;
          continue;
        }

        const expiresUnix = row.expires_utc
          ? Math.floor((Number(row.expires_utc) - 11644473600000000) / 1000000)
          : -1;

        const sameSiteMap: Record<number, string> = { 0: 'None', 1: 'Lax', 2: 'Strict' };

        cookies.push({
          name: row.name,
          value: row.value,
          domain: row.host_key,
          path: row.path,
          expires: expiresUnix > 0 ? expiresUnix : -1,
          httpOnly: !!row.is_httponly,
          secure: !!row.is_secure,
          sameSite: sameSiteMap[row.samesite] ?? 'None',
        });
      }
    } finally {
      await unlink(tmpPath).catch(() => {});
    }

    if (cookies.length === 0) {
      const hint = skippedEncrypted > 0
        ? `All ${skippedEncrypted} matching cookies were encrypted and could not be read without OS keychain access. Use capture_auth instead to log in via browser.`
        : `No cookies found${domain_filter ? ` matching domain "${domain_filter}"` : ''}. Make sure you are logged in to Chrome first.`;
      return {
        content: [{ type: 'text' as const, text: hint }],
        isError: true,
      };
    }

    const storageState = { cookies, origins: [] };
    await writeFile(save_path, JSON.stringify(storageState, null, 2), 'utf-8');

    return {
      content: [{
        type: 'text' as const,
        text: [
          `Chrome cookies imported successfully.`,
          `  Cookies imported: ${cookies.length}`,
          skippedEncrypted > 0 ? `  Skipped (encrypted): ${skippedEncrypted} — use capture_auth for these` : '',
          `  Saved to: ${save_path}`,
          ``,
          `Use this in future runs:`,
          `  run_one_liners: storage_state_path="${save_path}"`,
          `  run_csv:        storage_state_path="${save_path}"`,
        ].filter(Boolean).join('\n'),
      }],
    };
  }, 'import_chrome_cookies');
}
