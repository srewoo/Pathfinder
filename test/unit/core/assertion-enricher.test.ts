/**
 * Assertion enrichment — the fix for the shallow-oracle ceiling.
 *
 * Two properties matter, and they pull against each other:
 *
 *   DEPTH     — a generated test must assert on more than "a banner appeared"
 *   GROUNDING — every added assertion must describe something exploration
 *               actually OBSERVED, never something a model assumed
 *
 * The second is what keeps the first from becoming a false-positive engine, so
 * most of these tests check that nothing is added when there is no evidence.
 */
import { describe, it, expect } from 'vitest';
import {
  assertionDepth,
  channelsOf,
  describeEnrichment,
  enrichAssertions,
} from '../../../src/core/test-gen/assertion-enricher';
import type {
  ExecutionStep,
  InteractionGraph,
  ObservedAPI,
  PageNode,
} from '../../../src/storage/schemas';

const PAGE = 'https://app.test/signup';

const submitPlan = (): ExecutionStep[] => [
  { order: 0, action: 'navigate', value: PAGE, description: 'Open signup' },
  { order: 1, action: 'type', selector: '#email', value: 'a@b.co', description: 'Enter email' },
  { order: 2, action: 'click', selector: '#submit', description: 'Click Create account' },
  { order: 3, action: 'assert', selector: '.success', assertType: 'visible', description: 'Banner' },
];

const api = (over: Partial<ObservedAPI> = {}): ObservedAPI => ({
  endpoint: 'https://app.test/api/signup',
  method: 'POST',
  status: 201,
  context: 'form_submit',
  ...over,
});

function graph(node: Partial<PageNode> = {}): InteractionGraph {
  return {
    nodes: [
      {
        url: PAGE,
        title: 'Signup',
        elementCount: 5,
        ...node,
      } as PageNode,
    ],
    edges: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  } as InteractionGraph;
}

describe('depth: network channel', () => {
  it('given_an_observed_submit_API_then_an_api_status_assertion_is_added', () => {
    // The core upgrade. A DOM assertion cannot tell "saved" from "rendered the
    // word saved"; an observed endpoint can.
    const r = enrichAssertions(submitPlan(), graph({ apiEndpoints: [api()] }), { pageUrl: PAGE });
    const added = r.steps.find((s) => s.assertType === 'api_status');
    expect(added).toBeDefined();
    expect(added?.assertExpected).toBe('POST /api/signup 2xx');
    expect(r.channels).toContain('network');
  });

  it('given_a_status_class_then_it_is_asserted_as_2xx_not_the_exact_code', () => {
    // A 200-vs-201 difference is not a bug; asserting the exact code would make
    // a correct app fail after a harmless backend change.
    const r = enrichAssertions(submitPlan(), graph({ apiEndpoints: [api({ status: 200 })] }), {
      pageUrl: PAGE,
    });
    expect(r.steps.find((s) => s.assertType === 'api_status')?.assertExpected).toContain('2xx');
  });

  it('given_only_GET_endpoints_then_no_write_assertion_is_added', () => {
    // A form that only issued a GET is a search. Asserting a write would be wrong.
    const r = enrichAssertions(
      submitPlan(),
      graph({ apiEndpoints: [api({ method: 'GET', status: 200 })] }),
      { pageUrl: PAGE }
    );
    expect(r.steps.some((s) => s.assertType === 'api_status')).toBe(false);
  });

  it('given_only_page_load_APIs_then_nothing_is_added', () => {
    // Page-load traffic says nothing about what the submit did.
    const r = enrichAssertions(
      submitPlan(),
      graph({ apiEndpoints: [api({ context: 'page_load' })] }),
      { pageUrl: PAGE }
    );
    expect(r.added).toEqual([]);
  });
});

describe('depth: url and absence channels', () => {
  it('given_an_observed_navigation_outcome_then_a_url_assertion_is_added', () => {
    const r = enrichAssertions(
      submitPlan(),
      graph({
        formOutcomes: [
          {
            filledFields: ['#email'],
            submitSelector: '#submit',
            result: 'navigation',
            resultUrl: 'https://app.test/welcome',
          },
        ],
      }),
      { pageUrl: PAGE }
    );
    const urlAssert = r.steps.find((s) => s.assertType === 'url');
    expect(urlAssert?.assertExpected).toBe('/welcome');
    expect(r.channels).toContain('url');
  });

  it('given_observed_error_selectors_then_their_ABSENCE_is_asserted_on_a_positive_test', () => {
    // Stronger than asserting a success banner: absence of a real error element
    // cannot be satisfied by rendering optimistic text.
    const r = enrichAssertions(
      submitPlan(),
      graph({
        formOutcomes: [
          {
            filledFields: [],
            submitSelector: '#submit',
            result: 'success',
            errorSelectors: ['.field-error', '.form-error'],
          },
        ],
      }),
      { pageUrl: PAGE }
    );
    const absence = r.steps.find((s) => s.assertType === 'not_visible');
    expect(absence?.selector).toBe('.field-error, .form-error');
    expect(r.channels).toContain('absence');
  });

  it('given_a_navigation_to_root_then_no_url_assertion_is_added', () => {
    // Asserting "/" matches nearly every page and would pass vacuously.
    const r = enrichAssertions(
      submitPlan(),
      graph({
        formOutcomes: [
          { filledFields: [], submitSelector: '#submit', result: 'navigation', resultUrl: 'https://app.test/' },
        ],
      }),
      { pageUrl: PAGE }
    );
    expect(r.steps.some((s) => s.assertType === 'url')).toBe(false);
  });
});

describe('negative tests assert the opposite', () => {
  it('given_a_negative_test_then_it_asserts_the_write_did_NOT_happen', () => {
    // The sharpest possible check for a validation bypass, and one no banner
    // assertion can make.
    const r = enrichAssertions(submitPlan(), graph({ apiEndpoints: [api()] }), {
      pageUrl: PAGE,
      negative: true,
    });
    const notCalled = r.steps.find((s) => s.assertType === 'api_not_called');
    expect(notCalled?.assertExpected).toBe('POST /api/signup');
    expect(r.steps.some((s) => s.assertType === 'api_status')).toBe(false);
  });

  it('given_a_negative_test_then_it_asserts_the_apps_real_error_appears', () => {
    const r = enrichAssertions(
      submitPlan(),
      graph({
        formOutcomes: [
          {
            filledFields: [],
            submitSelector: '#submit',
            result: 'validation_error',
            errorSelectors: ['.field-error'],
          },
        ],
      }),
      { pageUrl: PAGE, negative: true }
    );
    const shown = r.steps.find((s) => s.assertType === 'visible' && s.selector === '.field-error');
    expect(shown).toBeDefined();
  });
});

describe('grounding: nothing is invented', () => {
  it('given_no_graph_then_nothing_is_added', () => {
    const r = enrichAssertions(submitPlan(), undefined, { pageUrl: PAGE });
    expect(r.added).toEqual([]);
  });

  it('given_a_graph_with_no_observations_then_nothing_is_added', () => {
    expect(enrichAssertions(submitPlan(), graph(), { pageUrl: PAGE }).added).toEqual([]);
  });

  it('given_a_plan_with_no_submit_like_step_then_nothing_is_added', () => {
    // Enriching every click would attach write assertions to navigation links and
    // fail correct behaviour.
    const browsePlan: ExecutionStep[] = [
      { order: 0, action: 'navigate', value: PAGE, description: 'Open' },
      { order: 1, action: 'click', selector: '#nav-help', description: 'Open help page' },
      { order: 2, action: 'assert', selector: 'h1', assertType: 'visible', description: 'Heading' },
    ];
    const r = enrichAssertions(browsePlan, graph({ apiEndpoints: [api()] }), { pageUrl: PAGE });
    expect(r.added).toEqual([]);
  });

  it('given_an_empty_plan_then_it_does_not_throw', () => {
    expect(() => enrichAssertions([], graph({ apiEndpoints: [api()] }))).not.toThrow();
  });
});

describe('idempotence', () => {
  it('given_enrichment_run_twice_then_assertions_are_not_duplicated', () => {
    // Generation runs repeatedly (regeneration, healing, re-planning). A plan that
    // grew a copy each pass would be slow and unreadable.
    const g = graph({ apiEndpoints: [api()] });
    const once = enrichAssertions(submitPlan(), g, { pageUrl: PAGE });
    const twice = enrichAssertions(once.steps, g, { pageUrl: PAGE });
    expect(twice.added).toEqual([]);
    expect(twice.steps).toHaveLength(once.steps.length);
  });

  it('given_a_plan_that_already_asserts_the_api_then_it_is_not_added_again', () => {
    const plan: ExecutionStep[] = [
      ...submitPlan(),
      {
        order: 4,
        action: 'assert',
        assertType: 'api_status',
        assertExpected: 'POST /api/signup 2xx',
        description: 'already present',
      },
    ];
    const r = enrichAssertions(plan, graph({ apiEndpoints: [api()] }), { pageUrl: PAGE });
    expect(r.added.some((a) => a.assertType === 'api_status')).toBe(false);
  });

  it('given_enrichment_then_step_orders_stay_contiguous', () => {
    const r = enrichAssertions(submitPlan(), graph({ apiEndpoints: [api()] }), { pageUrl: PAGE });
    expect(r.steps.map((s) => s.order)).toEqual(r.steps.map((_, i) => i));
  });
});

describe('depth measurement', () => {
  it('given_only_dom_assertions_then_depth_is_one_quarter', () => {
    expect(assertionDepth(submitPlan())).toBe(0.25);
  });

  it('given_all_four_channels_then_depth_is_one', () => {
    const steps: ExecutionStep[] = [
      { order: 0, action: 'assert', assertType: 'visible', selector: '.a', description: 'dom' },
      { order: 1, action: 'assert', assertType: 'api_called', assertExpected: 'POST /x', description: 'net' },
      { order: 2, action: 'assert', assertType: 'url', assertExpected: '/done', description: 'url' },
      { order: 3, action: 'assert', assertType: 'not_visible', selector: '.err', description: 'absence' },
    ];
    expect(assertionDepth(steps)).toBe(1);
    expect(channelsOf(steps)).toEqual(['absence', 'dom', 'network', 'url']);
  });

  it('given_ten_identical_dom_assertions_then_depth_does_not_rise', () => {
    // Counting channels rather than assertions is what stops generation padding
    // its way to a better score.
    const many: ExecutionStep[] = Array.from({ length: 10 }, (_, i) => ({
      order: i,
      action: 'assert' as const,
      assertType: 'visible' as const,
      selector: `.x${i}`,
      description: 'dom',
    }));
    expect(assertionDepth(many)).toBe(0.25);
  });

  it('given_enrichment_then_depth_measurably_increases', () => {
    const before = assertionDepth(submitPlan());
    const after = assertionDepth(
      enrichAssertions(
        submitPlan(),
        graph({
          apiEndpoints: [api()],
          formOutcomes: [
            {
              filledFields: [],
              submitSelector: '#submit',
              result: 'navigation',
              resultUrl: 'https://app.test/welcome',
              errorSelectors: ['.err'],
            },
          ],
        }),
        { pageUrl: PAGE }
      ).steps
    );
    expect(after).toBeGreaterThan(before);
    expect(after).toBe(1);
  });
});

describe('describeEnrichment', () => {
  it('given_additions_then_each_is_explained', () => {
    const r = enrichAssertions(submitPlan(), graph({ apiEndpoints: [api()] }), { pageUrl: PAGE });
    const text = describeEnrichment(r);
    expect(text).toContain('network');
    expect(text).toContain('/api/signup');
  });

  it('given_nothing_added_then_it_says_why', () => {
    expect(describeEnrichment(enrichAssertions(submitPlan(), undefined))).toMatch(/no observed API/);
  });
});
