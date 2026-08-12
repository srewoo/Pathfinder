/**
 * The extracted per-page exploration step (fix.md §4, §13).
 *
 * This is what makes exploration a durable job: the work runs against a `Driver`,
 * so the pump can execute it, commit, and survive being killed between pages.
 *
 * The property that makes it a VALID job step is idempotence — a replayed step must
 * not double-count anything, because the pump replays whenever a commit is
 * interrupted.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { applyPageResult, explorePage } from '../../src/core/explorer/explore-page-step';
import { createJsdomDriver } from '../benchmark/jsdom-driver';
import type { InteractionGraph } from '../../src/storage/schemas';

/**
 * The harness's REAL origin.
 *
 * Links are resolved in the page against `location.href`, as they must be in
 * production. jsdom's document lives at its own origin, so hard-coding a fictional
 * one here would make every link look cross-origin — a test artifact, not a bug.
 */
const ORIGIN = window.location.origin;

function emptyGraph(): InteractionGraph {
  return {
    nodes: [],
    edges: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  } as unknown as InteractionGraph;
}

function mount(html: string): void {
  document.body.innerHTML = html;
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.title = '';
});

describe('page observation', () => {
  it('given_a_form_then_constraints_are_captured', async () => {
    // These constraints are what the zero-token negative tests are derived from,
    // so losing them silently disables that whole generator.
    mount(`
      <form>
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required maxlength="40" />
        <input id="pw" name="pw" type="password" required minlength="8" />
        <select id="plan" name="plan"><option>Free</option><option>Pro</option></select>
      </form>`);
    document.title = 'Signup';

    const result = await explorePage(createJsdomDriver(), {
      url: `${ORIGIN}/signup`,
      depth: 0,
      origin: ORIGIN,
      maxDepth: 2,
    });

    expect(result.title).toBe('Signup');
    const email = result.formFields.find((f) => f.name === 'email');
    expect(email?.required).toBe(true);
    expect(email?.maxLength).toBe(40);
    expect(email?.label).toBe('Email');
    const pw = result.formFields.find((f) => f.name === 'pw');
    expect(pw?.minLength).toBe(8);
    const plan = result.formFields.find((f) => f.name === 'plan');
    expect(plan?.options).toEqual(['Free', 'Pro']);
  });

  it('given_hidden_and_submit_inputs_then_they_are_not_treated_as_fields', async () => {
    mount(`<form>
      <input type="hidden" name="csrf" value="x" />
      <input type="submit" value="Go" />
      <input id="real" name="real" />
    </form>`);
    const result = await explorePage(createJsdomDriver(), {
      url: `${ORIGIN}/f`,
      depth: 0,
      origin: ORIGIN,
      maxDepth: 2,
    });
    expect(result.formFields.map((f) => f.name)).toEqual(['real']);
  });

  it('given_links_then_same_origin_and_off_origin_are_distinguished', async () => {
    mount(`
      <a href="/settings">Settings</a>
      <a href="https://other.test/docs">External docs</a>
      <a href="#anchor">Jump</a>
      <a href="mailto:a@b.co">Mail</a>`);

    const result = await explorePage(createJsdomDriver(), {
      url: `${ORIGIN}/`,
      depth: 0,
      origin: ORIGIN,
      maxDepth: 2,
    });

    // Anchors and mailto are not navigation targets.
    expect(result.links).toHaveLength(2);
    expect(result.links.find((l) => l.url.includes('settings'))?.sameOrigin).toBe(true);
    expect(result.links.find((l) => l.url.includes('other.test'))?.sameOrigin).toBe(false);
  });

  it('given_off_origin_links_then_they_are_recorded_but_NOT_queued', async () => {
    // Recording them makes the coverage report honest; following them would walk
    // out of the app entirely.
    mount(`<a href="https://other.test/x">Away</a><a href="/inside">Inside</a>`);
    const result = await explorePage(createJsdomDriver(), {
      url: `${ORIGIN}/`,
      depth: 0,
      origin: ORIGIN,
      maxDepth: 2,
    });
    expect(result.links).toHaveLength(2);
    expect(result.nextTargets.map((t) => t.url)).toEqual([`${ORIGIN}/inside`]);
  });

  it('given_the_depth_limit_is_reached_then_nothing_is_queued', async () => {
    mount(`<a href="/deeper">Deeper</a>`);
    const result = await explorePage(createJsdomDriver(), {
      url: `${ORIGIN}/`,
      depth: 2,
      origin: ORIGIN,
      maxDepth: 2,
    });
    expect(result.links).toHaveLength(1);
    expect(result.nextTargets).toEqual([]);
  });

  it('given_an_error_page_then_it_is_flagged_as_broken_not_as_content', async () => {
    mount(`<h1>404 — Page not found</h1>`);
    const result = await explorePage(createJsdomDriver(), {
      url: `${ORIGIN}/gone`,
      depth: 0,
      origin: ORIGIN,
      maxDepth: 2,
    });
    expect(result.brokenLink).toBe(true);
  });

  it('given_a_short_but_legitimate_page_then_it_is_NOT_flagged_broken', async () => {
    // A content-poor page is not an error page; conflating them would report
    // false broken links on minimal pages.
    mount(`<h1>Settings</h1><p>Nothing to configure yet.</p>`);
    document.title = 'Settings';
    const result = await explorePage(createJsdomDriver(), {
      url: `${ORIGIN}/settings`,
      depth: 0,
      origin: ORIGIN,
      maxDepth: 2,
    });
    expect(result.brokenLink).toBe(false);
  });

  it('given_a_risky_form_then_the_step_reports_its_risk_weight_and_reasons', async () => {
    mount(`<form>
      <input id="card" name="cardNumber" required />
      <input id="cvv" name="cvv" required />
    </form>`);
    const result = await explorePage(createJsdomDriver(), {
      url: `${ORIGIN}/checkout`,
      depth: 0,
      origin: ORIGIN,
      maxDepth: 2,
    });
    expect(result.risk.weight).toBeGreaterThan(5);
    expect(result.risk.reasons.join()).toMatch(/sensitive/);
  });

  it('given_observed_api_traffic_then_it_is_labelled_page_load_not_form_submit', async () => {
    // Mislabelling it would let the assertion enricher assert a write that no
    // submit ever triggered.
    const driver = createJsdomDriver();
    driver.recordRequest({
      requestId: '1',
      url: `${ORIGIN}/api/me`,
      method: 'GET',
      status: 200,
    });
    mount(`<h1>Home</h1>`);
    const result = await explorePage(driver, {
      url: `${ORIGIN}/`,
      depth: 0,
      origin: ORIGIN,
      maxDepth: 2,
    });
    expect(result.apiEndpoints).toHaveLength(1);
    expect(result.apiEndpoints[0].context).toBe('page_load');
  });
});

describe('idempotence — the property that makes this a valid job step', () => {
  it('given_the_same_result_applied_twice_then_the_graph_does_not_duplicate', async () => {
    // The pump replays a step whenever a commit was interrupted. A replay that
    // duplicated nodes or edges would corrupt the graph on every eviction.
    mount(`<a href="/settings">Settings</a><input id="q" name="q" />`);
    const result = await explorePage(createJsdomDriver(), {
      url: `${ORIGIN}/`,
      depth: 0,
      origin: ORIGIN,
      maxDepth: 2,
    });

    const graph = emptyGraph();
    applyPageResult(graph, result, `${ORIGIN}/home`);
    applyPageResult(graph, result, `${ORIGIN}/home`);

    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toHaveLength(1);
  });

  it('given_a_re_explore_with_richer_data_then_the_node_is_upgraded_not_replaced_blank', async () => {
    const graph = emptyGraph();
    applyPageResult(
      graph,
      {
        url: `${ORIGIN}/x`,
        title: '',
        elementCount: 0,
        formFields: [],
        apiEndpoints: [],
        links: [],
        nextTargets: [],
        risk: { url: `${ORIGIN}/x`, title: '', weight: 1, reasons: [], covered: true },
        brokenLink: false,
        authWall: false,
      },
      undefined
    );

    mount(`<h1>Real</h1><input id="a" name="a" required />`);
    document.title = 'Real page';
    const richer = await explorePage(createJsdomDriver(), {
      url: `${ORIGIN}/x`,
      depth: 0,
      origin: ORIGIN,
      maxDepth: 2,
    });
    applyPageResult(graph, richer, undefined);

    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].title).toBe('Real page');
    expect(graph.nodes[0].formFields).toHaveLength(1);
  });

  it('given_repeated_api_observations_then_they_are_deduped', async () => {
    const graph = emptyGraph();
    const driver = createJsdomDriver();
    driver.recordRequest({ requestId: '1', url: `${ORIGIN}/api/me`, method: 'GET', status: 200 });
    mount(`<h1>Home</h1>`);
    const result = await explorePage(driver, {
      url: `${ORIGIN}/`,
      depth: 0,
      origin: ORIGIN,
      maxDepth: 2,
    });

    applyPageResult(graph, result);
    applyPageResult(graph, result);
    expect(graph.nodes[0].apiEndpoints).toHaveLength(1);
  });
});
