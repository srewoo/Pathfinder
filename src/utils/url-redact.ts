/**
 * URL redaction for log output.
 *
 * Blocked-request warnings print the URL that was refused, and plenty of real
 * URLs carry a credential in the query string — `?api_key=`, `?token=`, a
 * signed-URL signature, a password-reset code. Logging one verbatim writes a
 * live secret into a console the user may well paste into a bug report.
 *
 * Only the query is touched. The origin and path are the diagnostic value of
 * the line — without them a blocked-request warning says nothing useful.
 */
import { SENSITIVE_KEY_RX } from '../core/analysis/body-redaction';

/** Query values longer than this are redacted whatever their key is named. */
const LONG_VALUE_LEN = 40;

/**
 * Strip separators before matching the key.
 *
 * The shared key list spells `api_key` and `apikey`; real query strings also
 * use `api-key`, `dd-api-key`, `X-Amz-Signature`. Normalising here catches
 * every spelling without widening the regex that governs stored bodies.
 */
function normalizeKey(key: string): string {
  return key.replace(/[-_.]/g, '');
}

/**
 * Redact sensitive query parameters, leaving origin and path intact.
 *
 * Never throws: a malformed URL is truncated at the first `?` rather than
 * logged whole, because a string that does not parse is exactly the case where
 * guessing is unsafe.
 */
export function redactUrlForLog(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    const q = url.indexOf('?');
    return q === -1 ? url : `${url.slice(0, q)}?[unparsed]`;
  }

  if (!parsed.search) return parsed.href;

  let changed = false;
  for (const [key, value] of [...parsed.searchParams.entries()]) {
    // A long opaque value is a credential often enough that the name it travels
    // under is not worth trusting.
    if (SENSITIVE_KEY_RX.test(normalizeKey(key)) || value.length > LONG_VALUE_LEN) {
      parsed.searchParams.set(key, '[redacted]');
      changed = true;
    }
  }
  if (!changed) return parsed.href;
  // `[` and `]` survive readably; percent-encoding them makes the line noisier
  // for no security gain.
  return parsed.href.replace(/%5Bredacted%5D/gi, '[redacted]');
}
