import { describe, it, expect } from 'vitest';
import {
  describePolicy,
  isPolicyEmpty,
  resolvePolicy,
} from '../../../src/core/safety/policy-resolver';
import { decide } from '../../../src/core/safety/origin-policy';

describe('resolvePolicy', () => {
  it('given_a_start_url_then_its_origin_becomes_the_allowlist', () => {
    const p = resolvePolicy({ startUrl: 'https://app.test/login?next=/x' });
    expect(p.allowedOrigins).toEqual(['https://app.test']);
  });

  it('given_no_start_url_then_the_policy_is_empty_and_fails_closed', () => {
    // A run whose target we cannot identify is a run we cannot scope.
    const p = resolvePolicy({});
    expect(isPolicyEmpty(p)).toBe(true);
    expect(decide({ url: 'https://anything/', method: 'GET' }, p).allow).toBe(false);
  });

  it('given_an_unparseable_start_url_then_the_policy_is_empty', () => {
    expect(isPolicyEmpty(resolvePolicy({ startUrl: 'not a url' }))).toBe(true);
  });

  it('given_no_explicit_opt_in_then_mutations_are_blocked', () => {
    // Running a test is not, by itself, permission to write to the target.
    const p = resolvePolicy({ startUrl: 'https://app.test/' });
    expect(p.allowMutations).toBe(false);
    expect(decide({ url: 'https://app.test/api', method: 'POST' }, p).allow).toBe(false);
  });

  it('given_an_explicit_opt_in_then_mutations_are_permitted_on_allowlisted_origins_only', () => {
    const p = resolvePolicy({ startUrl: 'https://app.test/', allowMutations: true });
    expect(decide({ url: 'https://app.test/api', method: 'POST' }, p).allow).toBe(true);
    // Opting into mutations must NOT widen the allowlist.
    expect(decide({ url: 'https://prod.corp/api', method: 'POST' }, p).allow).toBe(false);
  });

  it('given_extra_origins_then_they_are_added_but_never_inferred', () => {
    const p = resolvePolicy({
      startUrl: 'https://app.test/',
      extraOrigins: ['https://api.app.test'],
    });
    expect(p.allowedOrigins).toContain('https://api.app.test');
    expect(decide({ url: 'https://api.app.test/v1', method: 'GET' }, p).allow).toBe(true);
    // A sibling subdomain that was NOT listed stays off the allowlist — asserted
    // by navigation, which is the act the origin gate refuses.
    expect(
      decide({ url: 'https://admin.app.test/', method: 'GET', resourceType: 'Document' }, p).allow
    ).toBe(false);
  });

  it('given_additional_urls_then_their_origins_are_included', () => {
    const p = resolvePolicy({
      startUrl: 'https://app.test/',
      additionalUrls: ['https://staging.app.test/home'],
    });
    expect(p.allowedOrigins).toEqual(
      expect.arrayContaining(['https://app.test', 'https://staging.app.test'])
    );
  });

  it('given_duplicate_origins_then_they_are_deduped', () => {
    const p = resolvePolicy({
      startUrl: 'https://app.test/a',
      additionalUrls: ['https://app.test/b'],
      extraOrigins: ['https://app.test'],
    });
    expect(p.allowedOrigins).toEqual(['https://app.test']);
  });

  it('given_a_different_port_then_it_is_a_different_origin', () => {
    const p = resolvePolicy({ startUrl: 'http://localhost:3000/' });
    expect(
      decide({ url: 'http://localhost:3001/', method: 'GET', resourceType: 'Document' }, p).allow
    ).toBe(false);
  });

  it('given_a_resolved_policy_then_third_party_subresources_still_load', () => {
    // Blocking fonts/CDN images breaks rendering, and a broken render
    // manufactures false positives.
    const p = resolvePolicy({ startUrl: 'https://app.test/' });
    expect(
      decide(
        { url: 'https://fonts.gstatic.com/x.woff2', method: 'GET', resourceType: 'Font' },
        p
      ).allow
    ).toBe(true);
  });
});

describe('describePolicy', () => {
  it('given_an_empty_policy_then_it_says_DENY_ALL_and_names_the_cause', () => {
    const text = describePolicy(resolvePolicy({}));
    expect(text).toContain('DENY ALL');
    expect(text).toContain('start URL');
  });

  it('given_a_read_only_policy_then_it_reports_mutations_blocked', () => {
    expect(describePolicy(resolvePolicy({ startUrl: 'https://app.test/' }))).toContain(
      'mutations blocked'
    );
  });

  it('given_a_mutating_policy_then_it_says_so_prominently', () => {
    expect(
      describePolicy(resolvePolicy({ startUrl: 'https://app.test/', allowMutations: true }))
    ).toContain('mutations ALLOWED');
  });
});
