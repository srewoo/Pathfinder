/**
 * Deterministic defect detectors (fix.md §9, §10).
 *
 * Zero tokens, no LLM, fully reproducible — the class of finding Pathfinder can
 * be trusted on today. Each detector answers one narrow question and reports
 * evidence, so a finding can be judged rather than believed.
 *
 * Every detector takes a `Driver`, which means all of them run identically in a
 * real browser and against the benchmark's jsdom harness. That is what makes the
 * false-positive rate measurable (§10): the same code produces the numbers and
 * ships to users.
 */
import type { Driver } from '../driver';
import { fromCss, type Locator } from '../locator';

export type FindingKind =
  | 'validation-bypass'
  | 'broken-link'
  | 'server-error'
  | 'a11y-missing-label'
  | 'dead-button'
  | 'state-not-persisted'
  // ── State-diff oracles (see ./state-oracles.ts) ──
  /** UI claimed success while nothing was persisted anywhere. */
  | 'success-without-persistence'
  /** UI claimed success while the server returned an error. */
  | 'success-over-failure'
  /** A read-only run attempted to change server state. */
  | 'unexpected-mutation'
  /** An action expected to persist produced no evidence of it. */
  | 'missing-persistence'
  /** The app surfaced an error message during the step. */
  | 'error-surfaced';

export type Severity = 'high' | 'medium' | 'low';

export interface Finding {
  kind: FindingKind;
  severity: Severity;
  /** One line, specific enough to act on. */
  message: string;
  /** What was observed. A finding without evidence is an opinion. */
  evidence: string;
  locator?: Locator;
  url?: string;
}

// ── Network-derived detectors ───────────────────────────────────────────────

/**
 * 5xx responses observed during a run.
 *
 * Deliberately excludes 4xx: a 401 on an unauthenticated probe or a 422 from a
 * negative test is correct behaviour, and reporting those is the single fastest
 * way to become noise.
 */
export function detectServerErrors(driver: Driver): Finding[] {
  return driver
    .networkLog()
    .filter((r) => r.status >= 500)
    .map((r) => ({
      kind: 'server-error' as const,
      severity: 'high' as const,
      message: `${r.method} ${stripQuery(r.url)} returned ${r.status}`,
      evidence: `HTTP ${r.status} observed during the run`,
      url: r.url,
    }));
}

/** 404/410 on a navigation target. */
export function detectBrokenLinks(driver: Driver): Finding[] {
  return driver
    .networkLog()
    .filter((r) => r.status === 404 || r.status === 410)
    .map((r) => ({
      kind: 'broken-link' as const,
      severity: 'medium' as const,
      message: `Link target ${stripQuery(r.url)} returns ${r.status}`,
      evidence: `HTTP ${r.status} for ${r.method} ${stripQuery(r.url)}`,
      url: r.url,
    }));
}

// ── DOM-derived detectors ───────────────────────────────────────────────────

/**
 * Inputs with no accessible name.
 *
 * Reuses the production accessible-name computation via the driver, so a name
 * this detector cannot find is also one a semantic locator cannot target — the
 * a11y finding and the testability gap are the same underlying problem.
 */
export async function detectMissingLabels(driver: Driver): Promise<Finding[]> {
  const unnamed = await driver.evaluate<Array<{ selector: string; type: string }>>(`(() => {
    const out = [];
    const inputs = document.querySelectorAll('input, select, textarea');
    for (const el of inputs) {
      const type = (el.getAttribute('type') || el.tagName).toLowerCase();
      if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'reset') continue;

      let name = (el.getAttribute('aria-label') || '').trim();
      if (!name) {
        const lb = el.getAttribute('aria-labelledby');
        if (lb) {
          const n = document.getElementById(lb);
          name = (n && n.textContent || '').trim();
        }
      }
      if (!name && el.id) {
        const lab = document.querySelector('label[for="' + el.id + '"]');
        name = (lab && lab.textContent || '').trim();
      }
      if (!name && el.closest) {
        const wrap = el.closest('label');
        name = (wrap && wrap.textContent || '').trim();
      }
      if (!name) name = (el.getAttribute('placeholder') || '').trim();
      if (!name) {
        out.push({
          selector: el.id ? '#' + el.id : (el.getAttribute('name') ? '[name="' + el.getAttribute('name') + '"]' : type),
          type: type,
        });
      }
    }
    return out;
  })()`);

  return (unnamed ?? []).map((u) => ({
    kind: 'a11y-missing-label' as const,
    severity: 'medium' as const,
    message: `Input ${u.selector} has no accessible name`,
    evidence: `No label, aria-label, aria-labelledby or placeholder resolves for this ${u.type} field`,
    locator: fromCss(u.selector),
  }));
}

// ── Interaction-derived detectors ───────────────────────────────────────────

/** A snapshot cheap enough to diff before/after an interaction. */
export interface DomFingerprint {
  url: string;
  text: string;
  elementCount: number;
  requestCount: number;
}

export async function fingerprint(driver: Driver): Promise<DomFingerprint> {
  const snap = await driver.snapshot();
  const elementCount = await driver.evaluate<number>('document.querySelectorAll("*").length');
  return {
    url: snap.url,
    text: (snap.text ?? '').trim(),
    elementCount: elementCount ?? 0,
    requestCount: driver.networkLog().length,
  };
}

export function fingerprintsDiffer(a: DomFingerprint, b: DomFingerprint): boolean {
  return (
    a.url !== b.url ||
    a.text !== b.text ||
    a.elementCount !== b.elementCount ||
    a.requestCount !== b.requestCount
  );
}

/**
 * A control that changes nothing when clicked.
 *
 * The false-positive risk here is real and shapes the design: a button that
 * toggles a CSS class, opens a native dialog, or copies to the clipboard changes
 * nothing this fingerprint can see. So the finding is `low` severity and worded
 * as "no observable change" rather than "broken" — an honest description of what
 * was actually established.
 */
export async function detectDeadControl(
  driver: Driver,
  locator: Locator,
  label: string
): Promise<Finding[]> {
  const before = await fingerprint(driver);
  try {
    await driver.click(locator, { timeoutMs: 500 });
  } catch {
    // Unclickable is a different (and already-reported) problem, not this one.
    return [];
  }
  const after = await fingerprint(driver);

  if (fingerprintsDiffer(before, after)) return [];

  return [
    {
      kind: 'dead-button',
      severity: 'low',
      message: `"${label}" produced no observable change when clicked`,
      evidence:
        `URL, visible text, element count and request count were all identical ` +
        `before and after the click`,
      locator,
    },
  ];
}

/**
 * A value that does not survive a round trip.
 *
 * Requires the caller to name the round trip (save → reload), because only the
 * caller knows which controls constitute one.
 */
export async function detectLostState(
  driver: Driver,
  opts: {
    field: Locator;
    save: Locator;
    reload: Locator;
    readback: Locator;
    value: string;
  }
): Promise<Finding[]> {
  await driver.type(opts.field, opts.value);
  await driver.click(opts.save);
  await driver.click(opts.reload);

  const shown = await driver.readText(opts.readback).catch(() => '');
  if (shown.includes(opts.value)) return [];

  return [
    {
      kind: 'state-not-persisted',
      severity: 'high',
      message: `Value "${opts.value}" was not retained after save and reload`,
      evidence: `Read back "${shown || '(empty)'}" instead of "${opts.value}"`,
      locator: opts.readback,
    },
  ];
}

/**
 * Invalid input that the app accepted.
 *
 * `successLocator` must be the app's own success signal. Asserting the *absence*
 * of an error would be weaker: a form that silently does nothing would pass.
 */
export async function detectValidationBypass(
  driver: Driver,
  opts: {
    fields: Array<{ locator: Locator; value: string }>;
    submit: Locator;
    successLocator: Locator;
    describe: string;
  }
): Promise<Finding[]> {
  for (const f of opts.fields) {
    await driver.type(f.locator, f.value).catch(() => undefined);
  }
  await driver.click(opts.submit).catch(() => undefined);

  const handle = await driver.resolve(opts.successLocator);
  if (!handle) return [];
  const sample = await driver.sample(handle);
  if (!sample.visible) return [];

  const banner = await driver.readText(opts.successLocator).catch(() => '');

  return [
    {
      kind: 'validation-bypass',
      severity: 'high',
      message: `Invalid input was accepted: ${opts.describe}`,
      evidence: `Success confirmation appeared ("${banner.slice(0, 80)}") despite invalid input`,
      locator: opts.submit,
    },
  ];
}

function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split('?')[0];
  }
}
