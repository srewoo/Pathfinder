/**
 * TestRail REST transport.
 *
 * Called directly from the extension with the user's own email and API key —
 * ADR-002 unchanged, no proxy, no credential ever leaving for a Pathfinder
 * endpoint. `fetch` is injected so the whole client is testable without a
 * network or a TestRail instance.
 *
 * Two collection response shapes are handled on purpose: TestRail 6.7+ wraps
 * collections (`{ tests: [...] }`) while older instances return a bare array.
 * Supporting only one would make import silently return nothing on the other,
 * which reads to the user as "the feature is broken" rather than "your instance
 * is a different version".
 */

export interface TestRailConfig {
  /** e.g. https://acme.testrail.io — with or without a trailing slash. */
  host: string;
  email: string;
  apiKey: string;
}

export interface TestRailTest {
  /** Test instance id within the run. */
  id: number;
  /** Case id — what a result is filed against. */
  caseId: number;
  title: string;
  steps: string[];
}

export interface ResultBody {
  status_id: number;
  comment?: string;
  /** TestRail duration format, e.g. '30s', '2m 15s'. Never '0s' — it is rejected. */
  elapsed?: string;
}

/** TestRail's default status ids. Custom statuses start at 6. */
export const TESTRAIL_STATUS = {
  passed: 1,
  blocked: 2,
  untested: 3,
  retest: 4,
  failed: 5,
} as const;

interface RawTest {
  id?: number;
  case_id?: number;
  title?: string;
  custom_steps?: string;
  custom_steps_separated?: Array<{ content?: string; expected?: string }>;
}

function endpoint(host: string, method: string): string {
  return `${host.replace(/\/+$/, '')}/index.php?/api/v2/${method}`;
}

function authHeader(config: TestRailConfig): string {
  return `Basic ${btoa(`${config.email}:${config.apiKey}`)}`;
}

/**
 * Turn a transport failure into a message that says what to fix.
 *
 * A bare "request failed: 401" sends the user to the network tab; naming the
 * credential or the run id sends them to the field that is wrong.
 */
async function failure(response: Response, context: string): Promise<Error> {
  if (response.status === 401 || response.status === 403) {
    return new Error(
      `TestRail rejected the credentials — check the TestRail email or API key (${response.status}).`
    );
  }
  if (response.status === 404) {
    return new Error(
      `TestRail could not find ${context} (404). Check the id, and that this account can see it.`
    );
  }
  const body = await response.text().catch(() => '');
  return new Error(`TestRail request failed for ${context}: ${response.status} ${body.slice(0, 200)}`);
}

function stepsOf(raw: RawTest): string[] {
  if (Array.isArray(raw.custom_steps_separated)) {
    return raw.custom_steps_separated
      .map((s) => (s.content ?? '').trim())
      .filter((s) => s.length > 0);
  }
  if (typeof raw.custom_steps === 'string') {
    return raw.custom_steps
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [];
}

function unwrapTests(payload: unknown): RawTest[] {
  if (Array.isArray(payload)) return payload as RawTest[];
  if (payload && typeof payload === 'object' && Array.isArray((payload as { tests?: unknown }).tests)) {
    return (payload as { tests: RawTest[] }).tests;
  }
  return [];
}

export function createTestRailClient(config: TestRailConfig, fetchImpl: typeof fetch = fetch) {
  const jsonHeaders = { Authorization: authHeader(config), 'Content-Type': 'application/json' };

  return {
    /** Tests in a run — the case ids, titles and steps to import. */
    async getTests(runId: number): Promise<TestRailTest[]> {
      const response = await fetchImpl(endpoint(config.host, `get_tests/${runId}`), {
        method: 'GET',
        headers: jsonHeaders,
      });
      if (!response.ok) throw await failure(response, `run ${runId}`);
      return unwrapTests(await response.json()).map((raw) => ({
        id: raw.id ?? 0,
        caseId: raw.case_id ?? 0,
        title: raw.title ?? '(untitled)',
        steps: stepsOf(raw),
      }));
    },

    async addResultForCase(runId: number, caseId: number, body: ResultBody): Promise<{ id: number }> {
      const response = await fetchImpl(endpoint(config.host, `add_result_for_case/${runId}/${caseId}`), {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(body),
      });
      if (!response.ok) throw await failure(response, `case ${caseId} in run ${runId}`);
      const parsed = (await response.json()) as { id?: number };
      return { id: parsed.id ?? 0 };
    },

    async addAttachmentToResult(resultId: number, png: Blob, filename: string): Promise<{ id: number }> {
      const form = new FormData();
      form.append('attachment', png, filename);
      const response = await fetchImpl(endpoint(config.host, `add_attachment_to_result/${resultId}`), {
        method: 'POST',
        // No Content-Type header: the browser must set the multipart boundary
        // itself, and setting it by hand produces a body TestRail cannot parse.
        headers: { Authorization: authHeader(config) },
        body: form,
      });
      if (!response.ok) throw await failure(response, `result ${resultId}`);
      const parsed = (await response.json()) as { id?: number };
      return { id: parsed.id ?? 0 };
    },
  };
}
