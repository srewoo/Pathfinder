/**
 * Risk-weighted coverage.
 *
 * The property that matters: the metric must be able to distinguish "explored the
 * whole app" from "discovered almost nothing and explored that". The old
 * self-referential ratio could not, and the first test here is the case that
 * exposed it.
 */
import { describe, it, expect } from 'vitest';
import {
  RISK_WEIGHTS,
  computeRiskCoverage,
  formatRiskCoverage,
  highestRiskPages,
  riskOf,
} from '../../../src/core/explorer/risk-coverage';
import type { FormField, InteractionGraph, PageNode } from '../../../src/storage/schemas';

const field = (over: Partial<FormField> = {}): FormField => ({
  selector: '#f',
  type: 'text',
  required: false,
  ...over,
});

const node = (over: Partial<PageNode> = {}): PageNode =>
  ({ url: 'https://app.test/', title: 'Page', elementCount: 0, ...over }) as PageNode;

function graph(nodes: PageNode[], edges: Array<{ from: string; to: string }> = []): InteractionGraph {
  return {
    nodes,
    edges: edges.map((e) => ({ ...e, action: 'link', selector: '', label: '' })),
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  } as unknown as InteractionGraph;
}

describe('the flaw this replaces', () => {
  it('given_one_page_discovered_and_visited_then_risk_coverage_does_NOT_claim_full_app_coverage_of_a_risky_app', () => {
    // The old metric scored mapped/(mapped+discovered) = 1/1 = 100% here.
    // Risk weighting cannot fix an app you never saw, BUT it does expose the
    // difference the moment anything else is discovered.
    const trivial = computeRiskCoverage({ graph: graph([node()]), discoveredNotVisited: [] });
    expect(trivial.ratio).toBe(1);

    // Discovering three more pages and skipping them now costs real weight.
    const partial = computeRiskCoverage({
      graph: graph([node()]),
      discoveredNotVisited: ['https://app.test/a', 'https://app.test/b', 'https://app.test/c'],
    });
    expect(partial.ratio).toBeLessThan(0.5);
  });

  it('given_a_heavy_page_explored_then_it_outweighs_several_trivial_gaps', () => {
    // The point of weighting: exploring checkout matters more than skipping three
    // static pages.
    const checkout = node({
      url: 'https://app.test/checkout',
      formFields: [field({ name: 'cardNumber', required: true }), field({ name: 'cvv', required: true })],
      apiEndpoints: [
        { endpoint: 'https://app.test/api/pay', method: 'POST', status: 201, context: 'form_submit' },
      ],
    });
    const r = computeRiskCoverage({
      graph: graph([checkout]),
      discoveredNotVisited: ['https://app.test/about', 'https://app.test/tos', 'https://app.test/faq'],
    });
    expect(r.ratio).toBeGreaterThan(0.75);
  });
});

describe('riskOf weighting', () => {
  it('given_a_static_page_then_it_scores_the_baseline', () => {
    expect(riskOf(node()).weight).toBe(RISK_WEIGHTS.base);
  });

  it('given_a_form_then_the_weight_rises', () => {
    const r = riskOf(node({ formFields: [field()] }));
    expect(r.weight).toBe(RISK_WEIGHTS.base + RISK_WEIGHTS.hasForm);
    expect(r.reasons.join()).toMatch(/form with 1 field/);
  });

  it('given_required_fields_then_each_adds_weight', () => {
    const r = riskOf(node({ formFields: [field({ required: true }), field({ required: true })] }));
    expect(r.weight).toBe(RISK_WEIGHTS.base + RISK_WEIGHTS.hasForm + 2 * RISK_WEIGHTS.requiredField);
  });

  it('given_a_password_or_card_field_then_it_is_weighted_as_sensitive', () => {
    // The costliest place to be wrong.
    for (const name of ['password', 'cardNumber', 'cvv', 'iban', 'ssn']) {
      const r = riskOf(node({ formFields: [field({ name })] }));
      expect(r.reasons.join(), name).toMatch(/sensitive/);
    }
  });

  it('given_an_observed_mutating_endpoint_then_it_outweighs_a_plain_form', () => {
    // Provable evidence the page writes beats the mere presence of inputs.
    const writes = riskOf(
      node({
        apiEndpoints: [
          { endpoint: 'https://a/api', method: 'POST', status: 201, context: 'form_submit' },
        ],
      })
    );
    const form = riskOf(node({ formFields: [field()] }));
    expect(writes.weight).toBeGreaterThan(form.weight);
  });

  it('given_only_GET_endpoints_then_no_mutation_weight_is_added', () => {
    const r = riskOf(
      node({
        apiEndpoints: [{ endpoint: 'https://a/api', method: 'GET', status: 200, context: 'page_load' }],
      })
    );
    expect(r.weight).toBe(RISK_WEIGHTS.base);
  });

  it('given_a_wizard_then_it_adds_weight_because_multi_step_flows_fail_midway', () => {
    const r = riskOf(node({ wizardSteps: [{ label: 'One' }, { label: 'Two' }] as never }));
    expect(r.reasons.join()).toMatch(/2-step wizard/);
  });

  it('given_many_interactive_elements_then_the_contribution_is_capped', () => {
    // Uncapped, one enormous page would dominate the whole metric.
    const huge = riskOf(node({ elementCount: 10_000 }));
    expect(huge.weight).toBe(RISK_WEIGHTS.base + RISK_WEIGHTS.maxInteractive);
  });

  it('given_every_reason_then_the_weight_is_auditable_from_them', () => {
    const r = riskOf(node({ formFields: [field({ name: 'password', required: true })] }));
    expect(r.reasons.length).toBeGreaterThanOrEqual(3);
  });
});

describe('gap reporting', () => {
  it('given_unexplored_pages_then_they_are_reported_as_gaps', () => {
    const r = computeRiskCoverage({
      graph: graph([node()]),
      discoveredNotVisited: ['https://app.test/x'],
    });
    expect(r.gaps.map((g) => g.url)).toEqual(['https://app.test/x']);
    expect(r.gaps[0].covered).toBe(false);
  });

  it('given_an_unexplored_page_then_its_risk_is_marked_unknown_not_assumed', () => {
    // Inflating unexplored weight would let the metric be gamed by discovering
    // more links; assuming zero would hide the gap. Baseline + honesty.
    const r = computeRiskCoverage({
      graph: graph([node()]),
      discoveredNotVisited: ['https://app.test/x'],
    });
    expect(r.gaps[0].weight).toBe(RISK_WEIGHTS.base);
    expect(r.gaps[0].reasons.join()).toMatch(/risk unknown/);
  });

  it('given_no_gaps_then_the_ratio_is_one', () => {
    expect(computeRiskCoverage({ graph: graph([node()]), discoveredNotVisited: [] }).ratio).toBe(1);
  });

  it('given_an_empty_graph_then_it_does_not_divide_by_zero', () => {
    expect(computeRiskCoverage({ graph: graph([]), discoveredNotVisited: [] }).ratio).toBe(1);
  });

  it('given_gaps_then_they_are_ordered_heaviest_first', () => {
    const r = computeRiskCoverage({
      graph: graph([node()]),
      discoveredNotVisited: ['https://app.test/a', 'https://app.test/b'],
    });
    for (let i = 1; i < r.gaps.length; i++) {
      expect(r.gaps[i - 1].weight).toBeGreaterThanOrEqual(r.gaps[i].weight);
    }
  });
});

describe('highestRiskPages', () => {
  it('given_a_graph_then_the_riskiest_pages_come_first', () => {
    const pages = highestRiskPages(
      graph([
        node({ url: 'https://app.test/about' }),
        node({
          url: 'https://app.test/checkout',
          formFields: [field({ name: 'cardNumber', required: true })],
          apiEndpoints: [
            { endpoint: 'https://app.test/api/pay', method: 'POST', status: 201, context: 'form_submit' },
          ],
        }),
      ])
    );
    expect(pages[0].url).toBe('https://app.test/checkout');
  });
});

describe('formatRiskCoverage', () => {
  it('given_gaps_then_the_report_lists_them_and_states_the_metric_is_a_floor', () => {
    const text = formatRiskCoverage(
      computeRiskCoverage({
        graph: graph([node()]),
        discoveredNotVisited: ['https://app.test/x'],
      })
    );
    expect(text).toMatch(/Risk-weighted coverage/);
    expect(text).toContain('https://app.test/x');
    // Honesty about the conservative weighting must survive into the report.
    expect(text).toMatch(/FLOOR on the real gap/);
  });

  it('given_many_gaps_then_the_remainder_is_disclosed', () => {
    const many = Array.from({ length: 30 }, (_, i) => `https://app.test/p${i}`);
    expect(
      formatRiskCoverage(computeRiskCoverage({ graph: graph([node()]), discoveredNotVisited: many }))
    ).toMatch(/and 15 more/);
  });
});
