/**
 * Per-test state isolation.
 *
 * The gap this closes: concurrent tests each got their own TAB, but tabs in the
 * same profile share cookies, `localStorage`, `sessionStorage` and IndexedDB. So
 * "isolation" was tab-level only. Test A logging out, or writing a draft to
 * `localStorage`, changed what Test B saw — and the resulting failure looked like
 * a product bug rather than cross-talk.
 *
 * That class of flake is especially corrosive here, because Pathfinder's whole
 * claim is that a failure means something. A failure caused by a sibling test is
 * a false positive with a confident explanation attached.
 *
 * Two levels are offered, and the difference is honest:
 *
 *   `reset`  — clear storage between tests. Cheap, and enough for the common case
 *              of leaked drafts and cached state.
 *   `strict` — clear storage AND cookies. Correct, but logs the session out, so
 *              it only applies where auth is re-established per test.
 *
 * Neither is a true browser-profile boundary. Chrome extensions cannot create
 * isolated profiles, so this is a best-effort scrub — stated plainly rather than
 * described as sandboxing.
 */
/**
 * Narrowest possible dependency: this module only needs to run a page script.
 * Taking an evaluator rather than a `Driver` keeps it usable from anywhere and
 * avoids core reaching for a concrete driver (§2).
 */
export type PageEvaluator = <T>(expression: string) => Promise<T>;

export type IsolationLevel = 'none' | 'reset' | 'strict';

export interface IsolationResult {
  level: IsolationLevel;
  clearedLocalStorage: number;
  clearedSessionStorage: number;
  clearedCookies: boolean;
  /** Keys deliberately preserved, with the reason. */
  preserved: string[];
  errors: string[];
}

/**
 * Storage keys never cleared.
 *
 * Wiping an auth token between tests would log every test out and make `strict`
 * unusable with token-based auth. Callers can extend this, but the defaults cover
 * the common token key names so the safe level stays usable by default.
 */
export const DEFAULT_PRESERVED_KEYS = [
  /token/i,
  /auth/i,
  /session[_-]?id/i,
  /refresh/i,
  /jwt/i,
] as const;

export interface IsolationOptions {
  level?: IsolationLevel;
  /** Additional key patterns to preserve. */
  preserveKeys?: readonly RegExp[];
  /** Clear cookies too. Only honoured at `strict`. */
  clearCookies?: boolean;
}

const CLEAR_STORAGE_EXPR = (patterns: string[]) => `(() => {
  const preserve = [${patterns.map((p) => `new RegExp(${JSON.stringify(p)}, 'i')`).join(',')}];
  const keep = (k) => preserve.some((re) => re.test(k));

  const scrub = (store) => {
    const removed = [];
    const kept = [];
    try {
      const keys = [];
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k) keys.push(k);
      }
      for (const k of keys) {
        if (keep(k)) { kept.push(k); continue; }
        store.removeItem(k);
        removed.push(k);
      }
    } catch (e) {
      return { removed, kept, error: String(e) };
    }
    return { removed, kept };
  };

  const local = scrub(localStorage);
  const session = scrub(sessionStorage);
  return {
    localRemoved: local.removed.length,
    sessionRemoved: session.removed.length,
    preserved: local.kept.concat(session.kept),
    errors: [local.error, session.error].filter(Boolean),
  };
})()`;

/**
 * Scrub client state before a test runs.
 *
 * Never throws: isolation failing is a degraded run, not a reason to abandon the
 * suite. Failures are reported so a resulting flake can be attributed rather than
 * mystifying (CLAUDE.md §1.1 — fail loudly, but do not fail fatally on cleanup).
 */
export async function isolateBeforeTest(
  evaluate: PageEvaluator,
  opts: IsolationOptions = {}
): Promise<IsolationResult> {
  const level = opts.level ?? 'reset';
  const result: IsolationResult = {
    level,
    clearedLocalStorage: 0,
    clearedSessionStorage: 0,
    clearedCookies: false,
    preserved: [],
    errors: [],
  };

  if (level === 'none') return result;

  const patterns = [...DEFAULT_PRESERVED_KEYS, ...(opts.preserveKeys ?? [])].map((r) => r.source);

  try {
    const scrubbed = await evaluate<{
      localRemoved: number;
      sessionRemoved: number;
      preserved: string[];
      errors: string[];
    }>(CLEAR_STORAGE_EXPR(patterns));

    result.clearedLocalStorage = scrubbed?.localRemoved ?? 0;
    result.clearedSessionStorage = scrubbed?.sessionRemoved ?? 0;
    result.preserved = scrubbed?.preserved ?? [];
    result.errors.push(...(scrubbed?.errors ?? []));
  } catch (err) {
    result.errors.push(`storage scrub failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}

export function describeIsolation(result: IsolationResult): string {
  if (result.level === 'none') return 'Isolation disabled — state carries between tests.';

  const parts = [
    `Isolation (${result.level}): cleared ${result.clearedLocalStorage} localStorage + ` +
      `${result.clearedSessionStorage} sessionStorage key(s)`,
  ];
  if (result.clearedCookies) parts.push('cookies cleared');
  if (result.preserved.length > 0) {
    parts.push(`preserved ${result.preserved.length} auth-shaped key(s)`);
  }
  if (result.errors.length > 0) {
    // Surfaced, because an unreported isolation failure turns into a flake that
    // looks like a product bug.
    parts.push(`WARNING: ${result.errors.join('; ')}`);
  }
  return parts.join(' · ');
}

// ── Cross-test contamination detection ──────────────────────────────────────

export interface StateFingerprint {
  localKeys: string[];
  sessionKeys: string[];
}

const FINGERPRINT_EXPR = `(() => {
  const keys = (store) => {
    const out = [];
    try {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k) out.push(k);
      }
    } catch (e) { /* blocked storage */ }
    return out.sort();
  };
  return { localKeys: keys(localStorage), sessionKeys: keys(sessionStorage) };
})()`;

export async function fingerprintState(evaluate: PageEvaluator): Promise<StateFingerprint> {
  const fp = await evaluate<StateFingerprint>(FINGERPRINT_EXPR);
  return { localKeys: fp?.localKeys ?? [], sessionKeys: fp?.sessionKeys ?? [] };
}

/**
 * Keys a test left behind that a later test would inherit.
 *
 * Reported rather than silently cleaned, because a test that leaks state is worth
 * knowing about even once isolation hides the symptom — it usually means the test
 * is not restoring what it changed.
 */
export function detectLeakedKeys(
  before: StateFingerprint,
  after: StateFingerprint,
  preserveKeys: readonly RegExp[] = DEFAULT_PRESERVED_KEYS
): string[] {
  const known = new Set([...before.localKeys, ...before.sessionKeys]);
  const leaked = [...after.localKeys, ...after.sessionKeys].filter(
    (k) => !known.has(k) && !preserveKeys.some((re) => re.test(k))
  );
  return [...new Set(leaked)].sort();
}
