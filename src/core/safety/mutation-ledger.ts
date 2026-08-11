/**
 * Mutation ledger (fix.md §7.4).
 *
 * Records every mutating request the policy permitted, so a run ends with an
 * exact statement of what it changed. Also records refusals, which is what
 * turns "the crawl found nothing" into "the crawl was blocked 40 times by the
 * allowlist" — the difference between a clean bill of health and a
 * misconfiguration.
 */
import type { PolicyDecision } from './origin-policy';

export interface LedgerEntry {
  at: number;
  url: string;
  method: string;
  /** 'permitted' entries changed remote state. 'refused' entries did not. */
  outcome: 'permitted' | 'refused';
  /** Populated for refusals. */
  reason?: string;
  rule?: 'origin' | 'method';
  /** Response status, when observed. Absent for aborted requests. */
  status?: number;
}

export interface MutationLedger {
  record(entry: Omit<LedgerEntry, 'at'>, at: number): void;
  noteStatus(url: string, method: string, status: number): void;
  entries(): readonly LedgerEntry[];
  permitted(): readonly LedgerEntry[];
  refused(): readonly LedgerEntry[];
  summary(): LedgerSummary;
  clear(): void;
}

export interface LedgerSummary {
  mutationsPermitted: number;
  requestsRefused: number;
  refusedByOrigin: number;
  refusedByMethod: number;
  /** Distinct `METHOD origin/path` strings that changed state. */
  changedEndpoints: string[];
}

const MAX_ENTRIES = 2_000;

export function createMutationLedger(): MutationLedger {
  let entries: LedgerEntry[] = [];

  return {
    record(entry, at) {
      // Bounded — an unbounded ledger is a memory leak in a long crawl
      // (CLAUDE.md §11.1). Drop the oldest, keeping recent evidence.
      if (entries.length >= MAX_ENTRIES) entries = entries.slice(-Math.floor(MAX_ENTRIES / 2));
      entries.push({ ...entry, at });
    },

    noteStatus(url, method, status) {
      // Walk backwards: the matching request is almost always the most recent.
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e.url === url && e.method === method && e.status === undefined) {
          e.status = status;
          return;
        }
      }
    },

    entries() {
      return entries;
    },

    permitted() {
      return entries.filter((e) => e.outcome === 'permitted');
    },

    refused() {
      return entries.filter((e) => e.outcome === 'refused');
    },

    summary() {
      const refused = entries.filter((e) => e.outcome === 'refused');
      const permitted = entries.filter((e) => e.outcome === 'permitted');
      const changed = new Set<string>();
      for (const e of permitted) changed.add(`${e.method.toUpperCase()} ${stripQuery(e.url)}`);
      return {
        mutationsPermitted: permitted.length,
        requestsRefused: refused.length,
        refusedByOrigin: refused.filter((e) => e.rule === 'origin').length,
        refusedByMethod: refused.filter((e) => e.rule === 'method').length,
        changedEndpoints: [...changed].sort(),
      };
    },

    clear() {
      entries = [];
    },
  };
}

/**
 * Query strings routinely carry tokens and PII, which must never reach a report
 * (CLAUDE.md §12.2). The path alone identifies the endpoint.
 */
export function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split('?')[0];
  }
}

/** Translate a policy decision into the ledger entry it warrants. */
export function entryFor(
  req: { url: string; method: string },
  decision: PolicyDecision
): Omit<LedgerEntry, 'at'> {
  if (decision.allow) {
    return { url: req.url, method: req.method, outcome: 'permitted' };
  }
  return {
    url: req.url,
    method: req.method,
    outcome: 'refused',
    reason: decision.reason,
    rule: decision.rule,
  };
}
