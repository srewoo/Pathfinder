import { describe, it, expect } from 'vitest';
import {
  createPolicy,
  decide,
  isMutating,
  isOriginAllowed,
  isPageCritical,
  isTopLevelNavigation,
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
  it('given_a_NAVIGATION_off_the_allowlist_then_refused_by_the_origin_rule', () => {
    // This is what the origin gate exists for: the crawler must not walk into
    // production or a third-party admin panel. Navigation is the act that does it.
    const d = decide(
      { url: 'https://prod.corp/api', method: 'GET', resourceType: 'Document' },
      appOnly
    );
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.rule).toBe('origin');
      expect(d.reason).toContain('not on the project allowlist');
    }
  });

  it('given_a_GET_of_unknown_resource_type_then_it_is_allowed', () => {
    // CDP always reports a resourceType in practice, so this is the defensive
    // path. It errs toward letting the page load: wrongly blocking breaks the app
    // and invalidates the whole run, while a wrongly-allowed read cannot write
    // anything — and the explorer refuses off-origin navigation independently.
    expect(decide({ url: 'https://prod.corp/api', method: 'GET' }, appOnly).allow).toBe(true);
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

  it('given_third_party_reads_disabled_then_every_offlist_request_is_refused', () => {
    // The hermetic posture: opt in when any off-allowlist traffic should fail.
    const strict = createPolicy({
      allowedOrigins: ['https://app.test'],
      allowThirdPartySubresources: false,
    });
    for (const resourceType of ['Image', 'Script', 'XHR', 'Font']) {
      const d = decide({ url: 'https://cdn.other/x', method: 'GET', resourceType }, strict);
      expect(d.allow, resourceType).toBe(false);
    }
  });

  it('given_the_apps_own_bundle_on_an_asset_CDN_then_it_LOADS', () => {
    // The regression this locks down, observed against a real app:
    //
    //   GET https://assets.cdn/ui-shell/remoteEntry.js
    //     net::ERR_BLOCKED_BY_CLIENT.Inspector
    //   Error: [ Federation Runtime ]: Failed to load script resources
    //
    // Script was missing from the passive-subresource set, so a strict policy
    // aborted the app's own code. The app never booted, the explorer mapped an
    // empty shell, and it reported that as the page. Blocking a script protects
    // nothing — a script cannot write anything by being fetched.
    const d = decide(
      { url: 'https://assets.cdn/ui-shell/remoteEntry.js', method: 'GET', resourceType: 'Script' },
      appOnly
    );
    expect(d.allow).toBe(true);
  });

  it('given_an_offlist_API_READ_then_it_is_allowed_because_the_PAGE_made_it', () => {
    // Changed deliberately, after this rule failed twice in the same direction.
    // Enumerating "safe" resource types blocked the app's own module-federation
    // bundles (typed Script), and then a Google Fonts stylesheet fetched
    // programmatically (typed XHR) — neither of which can write anything.
    //
    // A page's cross-origin GET is the app working; the crawler wandering is a
    // NAVIGATION, and damage is a MUTATION. Those two are what the gate stops.
    for (const resourceType of ['XHR', 'Fetch', 'Script', 'Stylesheet']) {
      const d = decide(
        { url: 'https://prod.corp/api/users', method: 'GET', resourceType },
        appOnly
      );
      expect(d.allow, resourceType).toBe(true);
    }
  });

  it('given_an_offlist_WRITE_then_it_is_refused_whatever_its_resource_type', () => {
    // The guarantee that actually matters: this run cannot write to an origin it
    // was not pointed at.
    for (const resourceType of ['XHR', 'Fetch', 'Script', undefined]) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const d = decide({ url: 'https://prod.corp/api/users', method, resourceType }, appOnly);
        expect(d.allow, `${method} ${resourceType}`).toBe(false);
      }
    }
  });

  it('given_an_offlist_navigation_then_it_is_STILL_refused', () => {
    const d = decide(
      { url: 'https://prod.corp/admin', method: 'GET', resourceType: 'Document' },
      appOnly
    );
    expect(d.allow).toBe(false);
  });

  it('given_an_offlist_script_with_a_mutating_verb_then_refused', () => {
    const d = decide(
      { url: 'https://assets.cdn/track.js', method: 'POST', resourceType: 'Script' },
      appOnly
    );
    expect(d.allow).toBe(false);
  });

  it('given_a_refusal_that_breaks_the_page_then_it_is_flagged_as_page_critical', () => {
    // Drives the loud report: a run whose scripts or API calls were blocked did
    // not test the app, and must not be reported as though it did.
    expect(isPageCritical('Script')).toBe(true);
    expect(isPageCritical('Document')).toBe(true);
    expect(isPageCritical('Stylesheet')).toBe(true);
    // A refused POST is the mutation gate working, not damage we caused.
    expect(isPageCritical('XHR')).toBe(false);
    expect(isPageCritical('Image')).toBe(false);
    expect(isPageCritical(undefined)).toBe(false);
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

describe('embedded frames are not the crawler leaving the app', () => {
  /**
   * Measured on a real run: a Storybook iframe from a design-library host was
   * aborted as though the crawler had tried to walk off-site.
   *
   *   BLOCKED Document GET https://design-library.example/stencil-3/iframe.html
   *
   * CDP reports both a top-level navigation and an embedded frame as resourceType
   * `Document`, so a rule based on resource type alone cannot tell them apart.
   * `Sec-Fetch-Dest` can: `document` vs `iframe`.
   */
  it('given_an_off_allowlist_IFRAME_then_it_loads', () => {
    const d = decide(
      {
        url: 'https://design-library.other/stencil-3/iframe.html?id=page--list',
        method: 'GET',
        resourceType: 'Document',
        destination: 'iframe',
      },
      appOnly
    );
    expect(d.allow).toBe(true);
  });

  it('given_an_off_allowlist_top_level_NAVIGATION_then_it_is_refused', () => {
    const d = decide(
      { url: 'https://prod.corp/', method: 'GET', resourceType: 'Document', destination: 'document' },
      appOnly
    );
    expect(d.allow).toBe(false);
  });

  it('given_other_embedded_destinations_then_they_load_too', () => {
    for (const destination of ['frame', 'embed', 'object', 'fencedframe']) {
      const d = decide(
        { url: 'https://widgets.other/w', method: 'GET', resourceType: 'Document', destination },
        appOnly
      );
      expect(d.allow, destination).toBe(true);
    }
  });

  it('given_no_Sec_Fetch_Dest_then_it_falls_back_to_the_resource_type', () => {
    // Conservative where the browser did not annotate the request.
    expect(isTopLevelNavigation({ url: 'https://x/', method: 'GET', resourceType: 'Document' })).toBe(true);
    expect(isTopLevelNavigation({ url: 'https://x/', method: 'GET', resourceType: 'XHR' })).toBe(false);
  });

  it('given_an_iframe_to_a_MUTATING_endpoint_then_it_is_still_refused', () => {
    // The embed exemption is about rendering, not about opening a write channel.
    const d = decide(
      { url: 'https://prod.corp/api', method: 'POST', resourceType: 'Document', destination: 'iframe' },
      appOnly
    );
    expect(d.allow).toBe(false);
  });
});
