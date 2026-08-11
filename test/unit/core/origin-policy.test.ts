import { describe, it, expect } from 'vitest';
import {
  createPolicy,
  decide,
  isMutating,
  isOriginAllowed,
  originOf,
} from '../../../src/core/safety/origin-policy';

const appOnly = createPolicy({ allowedOrigins: ['https://app.test'] });

describe('isOriginAllowed', () => {
  it('given_an_exact_origin_then_allowed', () => {
    expect(isOriginAllowed('https://app.test/login', ['https://app.test'])).toBe(true);
  });

  it('given_a_different_port_then_not_allowed', () => {
    // Origin includes the port — localhost:3000 and :3001 are different apps.
    expect(isOriginAllowed('http://localhost:3001/', ['http://localhost:3000'])).toBe(false);
  });

  it('given_a_wildcard_subdomain_then_subdomains_are_allowed', () => {
    expect(isOriginAllowed('https://staging.example.com/', ['*.example.com'])).toBe(true);
  });

  it('given_a_wildcard_then_a_lookalike_domain_is_refused', () => {
    // The bug this guards: `endsWith('example.com')` would wrongly match here.
    expect(isOriginAllowed('https://evil-example.com/', ['*.example.com'])).toBe(false);
  });

  it('given_a_wildcard_then_the_bare_apex_is_not_matched', () => {
    expect(isOriginAllowed('https://example.com/', ['*.example.com'])).toBe(false);
  });

  it('given_an_unparseable_url_then_refused', () => {
    // An origin we cannot determine is one we cannot allowlist.
    expect(isOriginAllowed('not a url', ['https://app.test'])).toBe(false);
  });

  it('given_a_bare_host_entry_then_either_scheme_matches', () => {
    expect(isOriginAllowed('https://app.test/x', ['app.test'])).toBe(true);
    expect(isOriginAllowed('http://app.test/x', ['app.test'])).toBe(true);
  });
});

describe('originOf', () => {
  it('given_a_url_then_returns_origin', () => {
    expect(originOf('https://app.test:8443/a/b?c=1')).toBe('https://app.test:8443');
  });
  it('given_garbage_then_returns_null', () => {
    expect(originOf('¯\\_(ツ)_/¯')).toBeNull();
  });
});

describe('isMutating', () => {
  it('given_write_verbs_then_true', () => {
    for (const m of ['POST', 'put', 'PATCH', 'delete']) expect(isMutating(m)).toBe(true);
  });
  it('given_read_verbs_then_false', () => {
    for (const m of ['GET', 'HEAD', 'options']) expect(isMutating(m)).toBe(false);
  });
});

describe('decide — origin gate', () => {
  it('given_an_offlist_origin_then_refused_by_origin_rule', () => {
    const d = decide({ url: 'https://prod.corp/api', method: 'GET' }, appOnly);
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.rule).toBe('origin');
      expect(d.reason).toContain('not on the project allowlist');
    }
  });

  it('given_an_offlist_passive_subresource_then_allowed_so_the_page_still_renders', () => {
    // Blocking fonts/CDN images breaks rendering, which manufactures false
    // positives — the metric that decides whether the tool stays switched on.
    const d = decide(
      { url: 'https://cdn.other/font.woff2', method: 'GET', resourceType: 'Font' },
      appOnly
    );
    expect(d.allow).toBe(true);
  });

  it('given_an_offlist_subresource_with_a_mutating_verb_then_still_refused', () => {
    const d = decide(
      { url: 'https://cdn.other/beacon', method: 'POST', resourceType: 'Image' },
      appOnly
    );
    expect(d.allow).toBe(false);
  });

  it('given_subresource_exemption_disabled_then_offlist_subresources_are_refused', () => {
    const strict = createPolicy({
      allowedOrigins: ['https://app.test'],
      allowThirdPartySubresources: false,
    });
    const d = decide({ url: 'https://cdn.other/x.png', method: 'GET', resourceType: 'Image' }, strict);
    expect(d.allow).toBe(false);
  });

  it('given_a_data_uri_then_always_allowed', () => {
    expect(decide({ url: 'data:text/html,hi', method: 'GET' }, appOnly).allow).toBe(true);
  });
});

describe('decide — method gate', () => {
  it('given_read_only_policy_then_allowlisted_GET_is_allowed', () => {
    expect(decide({ url: 'https://app.test/a', method: 'GET' }, appOnly).allow).toBe(true);
  });

  it('given_read_only_policy_then_allowlisted_POST_is_refused', () => {
    // The default posture: crawl and map, never submit.
    const d = decide({ url: 'https://app.test/api/orders', method: 'POST' }, appOnly);
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.rule).toBe('method');
      expect(d.reason).toContain('not flagged as mutating');
    }
  });

  it('given_a_mutating_run_then_allowlisted_POST_is_allowed', () => {
    const mutating = createPolicy({
      allowedOrigins: ['https://app.test'],
      allowMutations: true,
    });
    expect(decide({ url: 'https://app.test/api', method: 'POST' }, mutating).allow).toBe(true);
  });

  it('given_a_mutating_run_then_an_offlist_POST_is_still_refused_by_origin', () => {
    // Both gates are independent — enabling mutations must not widen the
    // allowlist. This is the combination that could otherwise hit production.
    const mutating = createPolicy({
      allowedOrigins: ['https://app.test'],
      allowMutations: true,
    });
    const d = decide({ url: 'https://prod.corp/api/delete', method: 'DELETE' }, mutating);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.rule).toBe('origin');
  });
});

describe('policy defaults', () => {
  it('given_only_origins_then_mutations_are_off_by_default', () => {
    // Read-only by default is the safety posture; it must not require opt-in.
    expect(createPolicy({ allowedOrigins: ['https://app.test'] }).allowMutations).toBe(false);
  });
});
