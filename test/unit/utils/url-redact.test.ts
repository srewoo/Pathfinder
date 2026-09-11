import { describe, it, expect } from 'vitest';
import { redactUrlForLog } from '../../../src/utils/url-redact';

describe('redactUrlForLog', () => {
  it('given_no_query_then_the_url_is_unchanged', () => {
    expect(redactUrlForLog('https://app.example.com/login')).toBe('https://app.example.com/login');
  });

  it('given_a_harmless_query_then_it_is_preserved_for_diagnostics', () => {
    const url = 'https://app.example.com/login?loginredirecturi=%2F';
    expect(redactUrlForLog(url)).toBe(url);
  });

  // The line has to stay useful: the origin and path are why it is logged.
  it('given_a_redaction_then_origin_and_path_survive', () => {
    const out = redactUrlForLog('https://browser-intake-datadoghq.com/api/v2/rum?dd-api-key=pub82dc4077');
    expect(out).toContain('https://browser-intake-datadoghq.com/api/v2/rum');
    expect(out).not.toContain('pub82dc4077');
  });

  it.each([
    'api_key',
    'apikey',
    'dd-api-key',
    'token',
    'access_token',
    'password',
    'auth',
    'session',
    'signature',
    'X-Amz-Signature',
    'secret',
    'email',
  ])('given_the_sensitive_parameter_%s_then_its_value_is_redacted', (key) => {
    const out = redactUrlForLog(`https://x.test/p?${key}=SUPERSECRETVALUE`);
    expect(out).not.toContain('SUPERSECRETVALUE');
    expect(out).toContain('[redacted]');
  });

  // A credential under an innocuous name is how most of them actually leak.
  it('given_a_long_value_under_a_harmless_key_then_it_is_still_redacted', () => {
    const long = 'a1B2'.repeat(15);
    const out = redactUrlForLog(`https://x.test/p?ref=${long}`);
    expect(out).not.toContain(long);
    expect(out).toContain('ref=[redacted]');
  });

  it('given_a_short_value_under_a_harmless_key_then_it_is_kept', () => {
    expect(redactUrlForLog('https://x.test/p?page=2')).toBe('https://x.test/p?page=2');
  });

  it('given_several_parameters_then_only_the_sensitive_ones_are_redacted', () => {
    const out = redactUrlForLog('https://x.test/p?page=2&token=abcd1234&sort=name');
    expect(out).toContain('page=2');
    expect(out).toContain('sort=name');
    expect(out).toContain('token=[redacted]');
  });

  it('given_a_redacted_value_then_the_marker_is_readable_not_percent_encoded', () => {
    expect(redactUrlForLog('https://x.test/p?token=abcd1234')).not.toContain('%5B');
  });

  // Failing to parse is exactly when guessing is unsafe.
  it('given_an_unparseable_url_with_a_query_then_the_query_is_dropped_entirely', () => {
    const out = redactUrlForLog('not a url?token=secretvalue');
    expect(out).not.toContain('secretvalue');
    expect(out).toBe('not a url?[unparsed]');
  });

  it('given_an_unparseable_url_with_no_query_then_it_is_returned_as_is', () => {
    expect(redactUrlForLog('not a url')).toBe('not a url');
  });

  it('given_an_empty_string_then_it_does_not_throw', () => {
    expect(() => redactUrlForLog('')).not.toThrow();
  });

  it('given_a_repeated_sensitive_key_then_every_occurrence_is_redacted', () => {
    const out = redactUrlForLog('https://x.test/p?token=aaa1&token=bbb2');
    expect(out).not.toContain('aaa1');
    expect(out).not.toContain('bbb2');
  });
});
