import { describe, it, expect, vi } from 'vitest';
import { createTestRailClient, TESTRAIL_STATUS } from '../../../src/core/integrations/testrail-client';

const config = { host: 'https://acme.testrail.io', email: 'qa@acme.com', apiKey: 'KEY' };

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('TESTRAIL_STATUS', () => {
  it('given_the_map_then_it_matches_testrail_defaults', () => {
    expect(TESTRAIL_STATUS).toEqual({ passed: 1, blocked: 2, untested: 3, retest: 4, failed: 5 });
  });
});

describe('getTests', () => {
  it('given_a_run_id_then_it_calls_get_tests_with_basic_auth', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ tests: [] }));
    await createTestRailClient(config, fetchImpl as unknown as typeof fetch).getTests(42);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://acme.testrail.io/index.php?/api/v2/get_tests/42');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${btoa('qa@acme.com:KEY')}`);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('given_a_wrapped_response_then_tests_are_read_from_the_tests_key', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        tests: [
          {
            id: 7,
            case_id: 900,
            title: 'Sign in',
            custom_steps_separated: [
              { content: 'Open the login page', expected: 'Login form shows' },
              { content: 'Enter credentials', expected: 'Home page shows' },
            ],
          },
        ],
      })
    );
    const tests = await createTestRailClient(config, fetchImpl as unknown as typeof fetch).getTests(42);
    expect(tests).toEqual([
      {
        id: 7,
        caseId: 900,
        title: 'Sign in',
        steps: ['Open the login page', 'Enter credentials'],
      },
    ]);
  });

  // Older TestRail returns a bare array. Both shapes must work or import
  // silently yields nothing on one of them.
  it('given_a_legacy_array_response_then_it_is_still_parsed', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([
        { id: 8, case_id: 901, title: 'Sign out', custom_steps: 'Click sign out\nConfirm' },
      ])
    );
    const tests = await createTestRailClient(config, fetchImpl as unknown as typeof fetch).getTests(42);
    expect(tests).toEqual([
      { id: 8, caseId: 901, title: 'Sign out', steps: ['Click sign out', 'Confirm'] },
    ]);
  });

  it('given_a_test_with_no_steps_then_steps_is_empty', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ tests: [{ id: 9, case_id: 902, title: 'Bare' }] }));
    const tests = await createTestRailClient(config, fetchImpl as unknown as typeof fetch).getTests(42);
    expect(tests[0].steps).toEqual([]);
  });

  it('given_an_unexpected_payload_then_no_tests_rather_than_a_throw', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ unexpected: true }));
    await expect(
      createTestRailClient(config, fetchImpl as unknown as typeof fetch).getTests(42)
    ).resolves.toEqual([]);
  });

  it('given_a_401_then_it_throws_a_message_naming_the_credentials', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'Authentication failed' }, 401));
    await expect(
      createTestRailClient(config, fetchImpl as unknown as typeof fetch).getTests(42)
    ).rejects.toThrow(/TestRail email or API key/i);
  });

  it('given_a_404_then_it_throws_a_message_naming_the_run_id', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'not found' }, 404));
    await expect(
      createTestRailClient(config, fetchImpl as unknown as typeof fetch).getTests(42)
    ).rejects.toThrow(/run 42/i);
  });

  it('given_a_trailing_slash_on_the_host_then_the_url_has_no_double_slash', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ tests: [] }));
    await createTestRailClient(
      { ...config, host: 'https://acme.testrail.io/' },
      fetchImpl as unknown as typeof fetch
    ).getTests(1);
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://acme.testrail.io/index.php?/api/v2/get_tests/1');
  });
});

describe('addResultForCase', () => {
  it('given_a_result_then_it_posts_to_add_result_for_case', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 555 }));
    const out = await createTestRailClient(config, fetchImpl as unknown as typeof fetch).addResultForCase(
      42,
      900,
      { status_id: TESTRAIL_STATUS.failed, comment: 'boom', elapsed: '3s' }
    );

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://acme.testrail.io/index.php?/api/v2/add_result_for_case/42/900');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      status_id: 5,
      comment: 'boom',
      elapsed: '3s',
    });
    expect(out).toEqual({ id: 555 });
  });

  it('given_a_500_then_it_throws_naming_the_case_and_run', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'boom' }, 500));
    await expect(
      createTestRailClient(config, fetchImpl as unknown as typeof fetch).addResultForCase(42, 900, {
        status_id: 1,
      })
    ).rejects.toThrow(/case 900 in run 42/);
  });
});

describe('addAttachmentToResult', () => {
  it('given_a_png_then_it_posts_multipart_without_a_json_content_type', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 12 }));
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    await createTestRailClient(config, fetchImpl as unknown as typeof fetch).addAttachmentToResult(
      555,
      blob,
      'fail.png'
    );

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://acme.testrail.io/index.php?/api/v2/add_attachment_to_result/555');
    expect(init.body).toBeInstanceOf(FormData);
    // The browser must set the multipart boundary itself.
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBeUndefined();
    expect(headers.Authorization).toBeDefined();
  });
});
