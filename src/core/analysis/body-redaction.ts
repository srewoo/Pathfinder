/**
 * Redaction for retained response bodies (ADR 001, phase 4).
 *
 * Phases 1–3 store only schemas, which is why they need no redaction: a shape holds no
 * values. Phase 4 exists for the one case a schema cannot serve — a human debugging why
 * a contract check fired needs to see the actual payload.
 *
 * That trade is only acceptable with redaction that fails toward deletion. Two
 * independent passes, because either alone leaks:
 *
 *   by KEY   — `token`, `password`, `ssn`, `email`… catches a value whose shape is
 *              unremarkable, like a name or a date of birth under `dob`
 *   by VALUE  — JWTs, long base64, card-like digit runs… catches a secret sitting under
 *              an innocuous key, which is how most credentials actually leak
 *
 * Redaction happens BEFORE storage, never on read. A body that reaches disk unredacted
 * is already a leak, whatever a reader does with it afterwards.
 */

/** Key names whose values are never retained, matched case-insensitively as substrings. */
const SENSITIVE_KEY_RX =
  /(pass|pwd|secret|token|auth|bearer|session|cookie|credential|apikey|api_key|private|signature|ssn|social|tax|nin|passport|licen[cs]e|dob|birth|salary|compensation|iban|account_?number|routing|card|cvv|pin|otp|mfa|email|phone|mobile|address|postcode|zip)/i;

/** Value shapes that are secrets regardless of the key they sit under. */
const SENSITIVE_VALUE_PATTERNS: Array<{ name: string; rx: RegExp }> = [
  { name: 'jwt', rx: /^ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+$/ },
  { name: 'bearer', rx: /^Bearer\s+\S{16,}$/i },
  // Requires mixed character classes: encoded bytes essentially always contain
  // upper, lower and digits, while a long run of one letter (or ordinary free text
  // with no spaces) does not. Without this, `'x'.repeat(500)` read as a secret and a
  // long description was destroyed instead of truncated.
  { name: 'base64', rx: /^(?=[A-Za-z0-9+/]{40,}={0,2}$)(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/ },
  { name: 'hex-secret', rx: /^[0-9a-f]{32,}$/i },
  { name: 'email', rx: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/ },
  { name: 'card', rx: /^(?:\d[ -]?){13,19}$/ },
  { name: 'private-key', rx: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

export interface RedactionResult {
  body: string;
  /** How many values were replaced. Reported so a reader knows the body is partial. */
  redactedCount: number;
  /** True when the body was cut to fit the size cap. */
  truncated: boolean;
}

export interface RedactOptions {
  /** Bytes of redacted JSON to keep. */
  maxBytes?: number;
  /** Strings longer than this are cut even when they are not secrets — free text. */
  maxStringLength?: number;
}

const DEFAULTS = { maxBytes: 32 * 1024, maxStringLength: 200 } as const;

const MASK = '«redacted»';

function redactValue(value: unknown, key: string | undefined, opts: Required<RedactOptions>, counter: { n: number }): unknown {
  if (value === null || typeof value === 'boolean') return value;

  if (typeof value === 'number') {
    // A number under a sensitive key (salary, account_number) is as revealing as a
    // string one.
    if (key && SENSITIVE_KEY_RX.test(key)) { counter.n++; return MASK; }
    return value;
  }

  if (typeof value === 'string') {
    if (key && SENSITIVE_KEY_RX.test(key)) { counter.n++; return MASK; }
    for (const { rx } of SENSITIVE_VALUE_PATTERNS) {
      if (rx.test(value.trim())) { counter.n++; return MASK; }
    }
    if (value.length > opts.maxStringLength) {
      counter.n++;
      return `${value.slice(0, opts.maxStringLength)}…«${value.length - opts.maxStringLength} more chars»`;
    }
    return value;
  }

  if (Array.isArray(value)) {
    // Keep a sample, not the set. A 500-row list debugs no better than 5 rows and
    // stores a hundred times the personal data.
    const kept = value.slice(0, 5).map((v) => redactValue(v, key, opts, counter));
    return value.length > 5 ? [...kept, `«${value.length - 5} more items»`] : kept;
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v, k, opts, counter);
    }
    return out;
  }

  return MASK;
}

/**
 * Redact a JSON body for retention.
 *
 * Unparseable input is dropped entirely rather than stored as-is: if we cannot walk it,
 * we cannot redact it, and storing what we cannot inspect is exactly the failure this
 * module prevents.
 */
export function redactBody(body: string, options: RedactOptions = {}): RedactionResult | null {
  const opts = { ...DEFAULTS, ...options };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  const counter = { n: 0 };
  const redacted = redactValue(parsed, undefined, opts, counter);
  let text = JSON.stringify(redacted);
  let truncated = false;
  if (text.length > opts.maxBytes) {
    text = text.slice(0, opts.maxBytes);
    truncated = true;
  }
  return { body: text, redactedCount: counter.n, truncated };
}
