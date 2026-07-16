/**
 * Network / API assertion oracle.
 *
 * Evaluates `api_called` / `api_not_called` / `api_status` assertions against the
 * HAR entries captured by the CDP Network domain during execution. Unlike DOM
 * assertions (run in the content script), these are evaluated in the executor
 * because the request/response data lives in the CDP client, not the page.
 *
 * assertExpected grammar (whitespace-separated):
 *   api_called / api_not_called : "[METHOD] <urlSubstring>"
 *   api_status                  : "[METHOD] <urlSubstring> <status>"
 * where METHOD is an optional HTTP verb (GET/POST/…) and status is an exact code
 * ("200") or a class ("2xx", "4xx", "5xx").
 *
 * Examples:
 *   api_called      "POST /api/login"
 *   api_not_called  "/api/error"
 *   api_status      "POST /api/login 200"
 *   api_status      "/api/orders 2xx"
 */
import type { ExecutionStep, AssertType } from '../../storage/schemas';
import { getHAREntries, isAttached, type HAREntry } from '../cdp/cdp-client';

const NETWORK_ASSERT_TYPES = new Set<AssertType>(['api_called', 'api_not_called', 'api_status']);
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

export interface NetworkAssertionResult {
  passed: boolean;
  error?: string;
}

/** True when this step is an API/network assertion evaluated against HAR. */
export function isNetworkAssertion(step: ExecutionStep): boolean {
  return step.action === 'assert' && !!step.assertType && NETWORK_ASSERT_TYPES.has(step.assertType);
}

interface AssertionSpec {
  method?: string;
  urlSubstring: string;
  status?: string;
}

/** Parse the assertExpected string into { method?, urlSubstring, status? }. */
export function parseNetworkSpec(raw: string, needsStatus: boolean): AssertionSpec | null {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  let method: string | undefined;
  if (HTTP_METHODS.has(tokens[0].toUpperCase())) {
    method = tokens.shift()!.toUpperCase();
  }

  let status: string | undefined;
  if (needsStatus) {
    // The trailing token is the status code / class.
    const last = tokens[tokens.length - 1];
    if (last && /^\d{3}$|^[1-5]xx$/i.test(last)) {
      status = tokens.pop()!.toLowerCase();
    } else {
      return null; // api_status requires a parseable status
    }
  }

  const urlSubstring = tokens.join(' ').trim();
  if (!urlSubstring) return null;
  return { method, urlSubstring, status };
}

function statusMatches(actual: number, expected: string): boolean {
  if (/^\d{3}$/.test(expected)) return actual === Number(expected);
  // Class match: "2xx" → 200-299
  const cls = Number(expected[0]);
  return Math.floor(actual / 100) === cls;
}

function entryMatches(entry: HAREntry, spec: AssertionSpec): boolean {
  if (spec.method && entry.method.toUpperCase() !== spec.method) return false;
  return entry.url.includes(spec.urlSubstring);
}

/**
 * Evaluate a network assertion against the tab's captured HAR. Requires an
 * active CDP capture — fails loudly (not silently) when unavailable so the user
 * knows the oracle couldn't run rather than seeing a false pass.
 */
export function evaluateNetworkAssertion(step: ExecutionStep, tabId: number): NetworkAssertionResult {
  if (!isAttached(tabId)) {
    return {
      passed: false,
      error: 'Network assertion requires CDP request capture, which is not active for this run. Enable CDP execution mode.',
    };
  }

  const needsStatus = step.assertType === 'api_status';
  const spec = parseNetworkSpec(step.assertExpected ?? '', needsStatus);
  if (!spec) {
    return {
      passed: false,
      error: `Could not parse network assertion "${step.assertExpected ?? ''}". Expected "[METHOD] urlSubstring${needsStatus ? ' status' : ''}".`,
    };
  }

  const entries = getHAREntries(tabId);
  const matches = entries.filter((e) => entryMatches(e, spec));
  const label = `${spec.method ? spec.method + ' ' : ''}${spec.urlSubstring}`;

  switch (step.assertType) {
    case 'api_called':
      return matches.length > 0
        ? { passed: true }
        : { passed: false, error: `Expected an API request matching "${label}" but none was observed (${entries.length} request(s) captured).` };

    case 'api_not_called':
      return matches.length === 0
        ? { passed: true }
        : { passed: false, error: `Expected NO API request matching "${label}", but ${matches.length} was/were observed (e.g. ${matches[0].method} ${matches[0].url}).` };

    case 'api_status': {
      const withStatus = matches.filter((e) => statusMatches(e.status, spec.status!));
      if (withStatus.length > 0) return { passed: true };
      const observed = matches.length > 0
        ? `matching requests returned: ${[...new Set(matches.map((m) => m.status))].join(', ')}`
        : 'no matching request was observed';
      return { passed: false, error: `Expected "${label}" to return ${spec.status}, but ${observed}.` };
    }

    default:
      return { passed: false, error: `Unsupported network assertion: ${String(step.assertType)}` };
  }
}
