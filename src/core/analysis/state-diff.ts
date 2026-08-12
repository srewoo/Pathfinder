/**
 * State capture and diffing — the substrate for deeper oracles.
 *
 * The gap this closes: generated assertions overwhelmingly checked "a success
 * banner appeared" or "no error showed". That catches crashes, not the order
 * saved with the wrong total. An oracle can only be as good as the state it can
 * observe, so first make the state observable.
 *
 * Four channels are captured, chosen because between them they cover what a web
 * action can actually change:
 *
 *   DOM      — what the user can see
 *   Network  — what the server was told
 *   Storage  — what the client persisted
 *   URL      — where the user ended up
 *
 * Deterministic and zero-token by construction (§9). The diff is structured
 * data, not prose, so an oracle reading it can be mechanical — and a model asked
 * to judge it gets facts rather than a screenshot.
 */
import type { Driver, NetworkResponse } from '../driver';

// ── Snapshot ────────────────────────────────────────────────────────────────

export interface DomFacts {
  /** Collapsed visible text, capped. What the user can actually read. */
  text: string;
  /**
   * Length of `textContent` — INCLUDING text that is currently hidden.
   *
   * Carried alongside `text` because `innerText` is layout-dependent: it omits
   * hidden nodes, and jsdom implements it poorly. Without this, revealing an
   * already-populated element (a very common way to show a message) registered as
   * "nothing changed" and the dead-control oracle reported a false positive.
   * A cheap length is enough to detect the change without storing the text twice.
   */
  textContentLength: number;
  elementCount: number;
  /** Counts by tag for the interactive/structural tags that carry meaning. */
  tagCounts: Record<string, number>;
  /** Values of named form fields, keyed by name or id. */
  fieldValues: Record<string, string>;
  /** Text of anything in an alert/status role — the app's own messaging. */
  liveRegions: string[];
}

export interface StorageFacts {
  local: Record<string, string>;
  session: Record<string, string>;
}

export interface StateSnapshot {
  url: string;
  title: string;
  dom: DomFacts;
  storage: StorageFacts;
  /** Number of network responses seen so far — the boundary for the diff. */
  networkCount: number;
}

/** Text is capped so a large page cannot make snapshots dominate memory. */
const MAX_TEXT = 4_000;
/** Storage values are capped: tokens and blobs live here and must not be kept. */
const MAX_STORAGE_VALUE = 200;

const SNAPSHOT_EXPR = `(() => {
  const cap = (s, n) => String(s == null ? '' : s).slice(0, n);
  const collapse = (s) => cap(String(s || '').replace(/\\s+/g, ' ').trim(), ${MAX_TEXT});

  const tagCounts = {};
  const interesting = ['input','button','a','form','select','textarea','table','tr','li','img','dialog'];
  for (const tag of interesting) {
    const n = document.querySelectorAll(tag).length;
    if (n > 0) tagCounts[tag] = n;
  }

  const fieldValues = {};
  for (const el of document.querySelectorAll('input, select, textarea')) {
    const type = (el.getAttribute('type') || '').toLowerCase();
    // Never capture secrets — a diff is written to reports and traces.
    if (type === 'password' || type === 'hidden') continue;
    const key = el.getAttribute('name') || el.id;
    if (!key) continue;
    if (type === 'checkbox' || type === 'radio') fieldValues[key] = el.checked ? 'on' : 'off';
    else fieldValues[key] = cap(el.value, 200);
  }

  const liveRegions = [];
  for (const el of document.querySelectorAll('[role="alert"], [role="status"], [aria-live]')) {
    const t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (t) liveRegions.push(cap(t, 300));
  }

  const readStore = (store) => {
    const out = {};
    try {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k) out[k] = cap(store.getItem(k), ${MAX_STORAGE_VALUE});
      }
    } catch (e) { /* storage can be blocked; an empty map is the honest answer */ }
    return out;
  };

  return {
    url: location.href,
    title: document.title,
    dom: {
      text: collapse(document.body ? (document.body.innerText || document.body.textContent) : ''),
      textContentLength: document.body ? String(document.body.textContent || '').length : 0,
      elementCount: document.querySelectorAll('*').length,
      tagCounts: tagCounts,
      fieldValues: fieldValues,
      liveRegions: liveRegions,
    },
    storage: { local: readStore(localStorage), session: readStore(sessionStorage) },
  };
})()`;

/**
 * Capture the observable state of the page.
 *
 * `networkCount` is read from the driver rather than the page: the page cannot
 * see its own request history, and the driver's log is the authoritative record.
 */
export async function captureState(driver: Driver): Promise<StateSnapshot> {
  const page = await driver.evaluate<Omit<StateSnapshot, 'networkCount'>>(SNAPSHOT_EXPR);
  return {
    url: page?.url ?? '',
    title: page?.title ?? '',
    dom: page?.dom ?? {
      text: '',
      textContentLength: 0,
      elementCount: 0,
      tagCounts: {},
      fieldValues: {},
      liveRegions: [],
    },
    storage: page?.storage ?? { local: {}, session: {} },
    networkCount: driver.networkLog().length,
  };
}

// ── Diff ────────────────────────────────────────────────────────────────────

export interface StorageChange {
  scope: 'local' | 'session';
  key: string;
  change: 'added' | 'removed' | 'changed';
  before?: string;
  after?: string;
}

export interface StateDiff {
  navigated: boolean;
  urlBefore: string;
  urlAfter: string;
  titleChanged: boolean;

  /** Net change in element count. Negative means the DOM shrank. */
  elementDelta: number;
  /** Tags whose count changed, with the delta. */
  tagDeltas: Record<string, number>;
  /** Live-region messages that appeared. The app's own account of what happened. */
  newMessages: string[];
  /** Form fields whose value changed, with before/after. */
  fieldChanges: Array<{ field: string; before: string; after: string }>;
  textChanged: boolean;

  storageChanges: StorageChange[];
  /** Responses observed during the action. */
  requests: NetworkResponse[];
  /** Mutating requests only — what the action told the server to change. */
  mutatingRequests: NetworkResponse[];
  /** Responses with status >= 400. */
  failedRequests: NetworkResponse[];

  /** True when NOTHING observable changed on any channel. */
  inert: boolean;
}

export function diffState(
  before: StateSnapshot,
  after: StateSnapshot,
  networkLog: readonly NetworkResponse[]
): StateDiff {
  const requests = networkLog.slice(before.networkCount, after.networkCount);
  const mutating = requests.filter((r) =>
    ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method.toUpperCase())
  );
  const failed = requests.filter((r) => r.status >= 400);

  const tagDeltas: Record<string, number> = {};
  const tags = new Set([
    ...Object.keys(before.dom.tagCounts),
    ...Object.keys(after.dom.tagCounts),
  ]);
  for (const tag of tags) {
    const delta = (after.dom.tagCounts[tag] ?? 0) - (before.dom.tagCounts[tag] ?? 0);
    if (delta !== 0) tagDeltas[tag] = delta;
  }

  // Only messages that are NEW: a banner already present before the action says
  // nothing about it, and treating it as evidence is how a stale success message
  // makes a broken action look fine.
  const seen = new Set(before.dom.liveRegions);
  const newMessages = after.dom.liveRegions.filter((m) => !seen.has(m));

  const fieldChanges: StateDiff['fieldChanges'] = [];
  const fields = new Set([
    ...Object.keys(before.dom.fieldValues),
    ...Object.keys(after.dom.fieldValues),
  ]);
  for (const field of fields) {
    const b = before.dom.fieldValues[field] ?? '';
    const a = after.dom.fieldValues[field] ?? '';
    if (b !== a) fieldChanges.push({ field, before: b, after: a });
  }

  const storageChanges = [
    ...diffStore('local', before.storage.local, after.storage.local),
    ...diffStore('session', before.storage.session, after.storage.session),
  ];

  const navigated = before.url !== after.url;
  // Either signal counts: visible text changing, or the amount of text in the DOM
  // changing (which catches a hidden element being populated or revealed).
  const textChanged =
    before.dom.text !== after.dom.text ||
    before.dom.textContentLength !== after.dom.textContentLength;

  return {
    navigated,
    urlBefore: before.url,
    urlAfter: after.url,
    titleChanged: before.title !== after.title,
    elementDelta: after.dom.elementCount - before.dom.elementCount,
    tagDeltas,
    newMessages,
    fieldChanges,
    textChanged,
    storageChanges,
    requests,
    mutatingRequests: mutating,
    failedRequests: failed,
    inert:
      !navigated &&
      !textChanged &&
      Object.keys(tagDeltas).length === 0 &&
      newMessages.length === 0 &&
      fieldChanges.length === 0 &&
      storageChanges.length === 0 &&
      requests.length === 0,
  };
}

function diffStore(
  scope: 'local' | 'session',
  before: Record<string, string>,
  after: Record<string, string>
): StorageChange[] {
  const out: StorageChange[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const b = before[key];
    const a = after[key];
    if (b === a) continue;
    if (b === undefined) out.push({ scope, key, change: 'added', after: a });
    else if (a === undefined) out.push({ scope, key, change: 'removed', before: b });
    else out.push({ scope, key, change: 'changed', before: b, after: a });
  }
  return out;
}

// ── Reporting ───────────────────────────────────────────────────────────────

/**
 * One-line-per-channel summary.
 *
 * This is what gets handed to a model when asking "is this what the docs said
 * should happen?" — facts on four channels, not a screenshot, so the judgement
 * is grounded in observation rather than appearance.
 */
export function describeDiff(diff: StateDiff): string {
  if (diff.inert) return 'Nothing observable changed (DOM, network, storage and URL all identical).';

  const lines: string[] = [];
  if (diff.navigated) lines.push(`URL: ${diff.urlBefore} → ${diff.urlAfter}`);
  if (diff.newMessages.length) lines.push(`Messages shown: ${diff.newMessages.join(' | ')}`);

  if (diff.mutatingRequests.length) {
    lines.push(
      `Server writes: ${diff.mutatingRequests
        .map((r) => `${r.method} ${stripQuery(r.url)} → ${r.status}`)
        .join(', ')}`
    );
  }
  const reads = diff.requests.filter((r) => !diff.mutatingRequests.includes(r));
  if (reads.length) lines.push(`Server reads: ${reads.length} request(s)`);
  if (diff.failedRequests.length) {
    lines.push(
      `Failed requests: ${diff.failedRequests
        .map((r) => `${r.method} ${stripQuery(r.url)} → ${r.status}`)
        .join(', ')}`
    );
  }

  if (diff.storageChanges.length) {
    lines.push(
      `Client storage: ${diff.storageChanges
        .map((c) => `${c.scope}.${c.key} ${c.change}`)
        .join(', ')}`
    );
  }
  if (diff.fieldChanges.length) {
    lines.push(
      `Field values: ${diff.fieldChanges
        .map((f) => `${f.field} "${f.before}" → "${f.after}"`)
        .join(', ')}`
    );
  }
  const tags = Object.entries(diff.tagDeltas);
  if (tags.length) {
    lines.push(`DOM: ${tags.map(([t, d]) => `${d > 0 ? '+' : ''}${d} <${t}>`).join(', ')}`);
  } else if (diff.textChanged) {
    lines.push('DOM: visible text changed');
  }

  return lines.join('\n');
}

function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split('?')[0];
  }
}
