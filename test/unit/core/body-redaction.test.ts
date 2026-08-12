/**
 * Redaction for retained bodies (ADR 001, phase 4).
 *
 * Phases 1–3 need no redaction because they store shapes, not values. This module is
 * the price of the one thing a shape cannot do: let a human read the payload that made
 * a contract check fire.
 *
 * So every test here is a leak that must not happen. Two independent passes exist
 * because either alone leaks — a name under `dob` has an unremarkable shape, and a JWT
 * under `data` has an unremarkable key.
 */
import { describe, it, expect } from 'vitest';
import { redactBody } from '../../../src/core/analysis/body-redaction';

const parse = (body: string): Record<string, unknown> =>
  JSON.parse(body) as Record<string, unknown>;

describe('redaction by key name', () => {
  it('given_credential_keys_then_their_values_never_survive', () => {
    const r = redactBody(JSON.stringify({
      accessToken: 'abc123', password: 'hunter2', apiKey: 'k-1', sessionId: 's-1', refresh_token: 'r-1',
    }))!;
    const out = parse(r.body);
    for (const v of Object.values(out)) expect(v).toBe('«redacted»');
    expect(r.body).not.toContain('hunter2');
    expect(r.redactedCount).toBe(5);
  });

  it('given_personal_data_keys_then_they_are_redacted_even_when_the_value_looks_harmless', () => {
    // "Ada" is an unremarkable string; under `firstName` it is still personal data,
    // and under `dob` a plain date is too. Key matching is what catches these.
    const r = redactBody(JSON.stringify({
      dob: '1815-12-10', salary: 120000, homeAddress: '12 Main St', phone: '555 0100', ssn: '000-00-0000',
    }))!;
    const out = parse(r.body);
    expect(Object.values(out).every((v) => v === '«redacted»')).toBe(true);
    expect(r.body).not.toContain('1815');
    expect(r.body).not.toContain('120000');
  });

  it('given_ordinary_keys_then_values_are_kept_so_the_body_is_still_useful', () => {
    // Redacting everything would make retention pointless.
    const r = redactBody(JSON.stringify({ id: 7, status: 'active', count: 3 }))!;
    expect(parse(r.body)).toEqual({ id: 7, status: 'active', count: 3 });
    expect(r.redactedCount).toBe(0);
  });
});

describe('redaction by value shape', () => {
  it('given_a_JWT_under_an_innocuous_key_then_it_is_still_caught', () => {
    // How credentials actually leak: the key says nothing.
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const r = redactBody(JSON.stringify({ data: jwt }))!;
    expect(parse(r.body).data).toBe('«redacted»');
    expect(r.body).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('given_secret_shapes_then_each_is_caught', () => {
    const cases: Record<string, string> = {
      bearer: 'Bearer abcdefghijklmnopqrstuvwxyz012345',
      b64: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5YWJjZGVm',
      hex: 'deadbeefdeadbeefdeadbeefdeadbeef',
      mail: 'ada@corp.test',
      card: '4111 1111 1111 1111',
      key: '-----BEGIN RSA PRIVATE KEY-----MIIEow',
    };
    const r = redactBody(JSON.stringify(cases))!;
    const out = parse(r.body);
    for (const k of Object.keys(cases)) expect(out[k], k).toBe('«redacted»');
  });

  it('given_a_short_ordinary_number_string_then_it_is_not_mistaken_for_a_card', () => {
    const r = redactBody(JSON.stringify({ quantity: '12', year: '2026' }))!;
    expect(parse(r.body)).toEqual({ quantity: '12', year: '2026' });
  });
});

describe('bounding what is kept', () => {
  it('given_long_free_text_then_it_is_cut_with_the_remainder_declared', () => {
    const long = 'x'.repeat(500);
    const r = redactBody(JSON.stringify({ description: long }))!;
    const value = String(parse(r.body).description);
    expect(value.length).toBeLessThan(300);
    expect(value).toContain('more chars');
  });

  it('given_a_long_array_then_a_sample_is_kept_and_the_rest_counted', () => {
    // 500 rows debug no better than 5 and store a hundred times the personal data.
    const rows = Array.from({ length: 500 }, (_, i) => ({ id: i }));
    const r = redactBody(JSON.stringify({ rows }))!;
    const kept = parse(r.body).rows as unknown[];
    expect(kept).toHaveLength(6);
    expect(String(kept[5])).toContain('495 more items');
  });

  it('given_a_body_over_the_size_cap_then_it_is_truncated_and_says_so', () => {
    // A WIDE object, not a long array: arrays are sampled to 5 items first, so an
    // array-shaped body shrinks below the cap before the cap can apply.
    const wide: Record<string, string> = {};
    for (let i = 0; i < 200; i++) wide[`field_${i}`] = `value_${i}`;
    const r = redactBody(JSON.stringify(wide), { maxBytes: 500 })!;
    expect(r.body.length).toBeLessThanOrEqual(500);
    expect(r.truncated).toBe(true);
  });

  it('given_nested_structures_then_redaction_reaches_all_the_way_down', () => {
    const r = redactBody(JSON.stringify({
      user: { profile: { contact: { email: 'ada@corp.test' } } },
    }))!;
    expect(r.body).not.toContain('ada@corp.test');
    expect(r.redactedCount).toBeGreaterThan(0);
  });
});

describe('what cannot be inspected is not stored', () => {
  it('given_a_non_JSON_body_then_nothing_is_retained', () => {
    // If we cannot walk it, we cannot redact it — and storing what we cannot inspect is
    // exactly the failure this module exists to prevent.
    expect(redactBody('<html><body>token=abc123</body></html>')).toBeNull();
    expect(redactBody('')).toBeNull();
    expect(redactBody('{ truncated json')).toBeNull();
  });
});
