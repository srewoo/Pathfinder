/**
 * Flow-generation quality benchmark.
 *
 * Flow learning was the best-DESIGNED feature and the least measured: its
 * correctness rested on the argument that "completeness is a property of graph
 * traversal, not of a non-deterministic extraction". That argument is right, and
 * it is also falsifiable — so this falsifies it.
 *
 * Fixture interaction graphs carry hand-labelled journeys a competent tester would
 * expect. The deterministic enumerator runs over them and is scored on:
 *
 *   COMPLETENESS — expected journeys the enumerator found
 *   SPURIOUSNESS — flows leading nowhere (no action, no destination)
 *   DUPLICATION  — the same journey emitted more than once
 *
 * Deliberately targets `enumerateSkeletons` rather than `learnFlows`: the skeleton
 * path is deterministic and needs no API key, so it can gate CI. The LLM layer
 * sits on top and cannot be measured hermetically — stated rather than glossed.
 */
import { describe, it, expect } from 'vitest';
import {
  dedupeBySignature,
  enumerateSkeletons,
  flowSignature,
} from '../../src/core/flow/skeleton-enumerator';
import type {
  FormField,
  InteractionGraph,
  PageEdge,
  PageNode,
} from '../../src/storage/schemas';

const field = (over: Partial<FormField> = {}): FormField => ({
  selector: '#f',
  type: 'text',
  required: false,
  ...over,
});

function node(url: string, over: Partial<PageNode> = {}): PageNode {
  return { url, title: titleOf(url), elementCount: 4, ...over } as PageNode;
}

function edge(from: string, to: string, label: string): PageEdge {
  return { from, to, action: 'click', selector: `a[href="${to}"]`, label } as PageEdge;
}

function titleOf(url: string): string {
  try {
    const p = new URL(url).pathname.replace(/\/$/, '');
    return p === '' ? 'Home' : p.split('/').pop()!.replace(/-/g, ' ');
  } catch {
    return url;
  }
}

function graph(nodes: PageNode[], edges: PageEdge[]): InteractionGraph {
  return {
    nodes,
    edges,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  } as unknown as InteractionGraph;
}

// ── Fixture apps with expected journeys ─────────────────────────────────────

interface FlowFixture {
  id: string;
  description: string;
  graph: InteractionGraph;
  /**
   * Journeys a competent tester would expect, as URL sequences.
   *
   * Must be ENTRY-ANCHORED — starting from a page a test can actually navigate to
   * directly. An earlier version listed intermediate hops (`shipping → payment`)
   * and scored the enumerator at 78%, but a test cannot begin mid-flow: reaching
   * `shipping` requires walking from `cart`. The enumerator was right to express
   * that as `cart → shipping → payment`, and the ground truth was mislabelled.
   */
  expectedJourneys: string[][];
}

const SHOP = 'https://shop.test';
const ADMIN = 'https://admin.test';

const FIXTURES: FlowFixture[] = [
  {
    id: 'linear-checkout',
    description: 'cart → shipping → payment → confirmation',
    graph: graph(
      [
        node(`${SHOP}/cart`),
        node(`${SHOP}/shipping`, { formFields: [field({ name: 'address', required: true })] }),
        node(`${SHOP}/payment`, {
          formFields: [field({ name: 'cardNumber', required: true })],
          apiEndpoints: [
            { endpoint: `${SHOP}/api/pay`, method: 'POST', status: 201, context: 'form_submit' },
          ],
        }),
        node(`${SHOP}/confirmation`),
      ],
      [
        edge(`${SHOP}/cart`, `${SHOP}/shipping`, 'Continue'),
        edge(`${SHOP}/shipping`, `${SHOP}/payment`, 'Continue to payment'),
        edge(`${SHOP}/payment`, `${SHOP}/confirmation`, 'Pay now'),
      ]
    ),
    expectedJourneys: [
      // Entry-anchored and progressive — the shapes a runnable test can take.
      [`${SHOP}/cart`, `${SHOP}/shipping`],
      [`${SHOP}/cart`, `${SHOP}/payment`],
      [`${SHOP}/cart`, `${SHOP}/confirmation`],
    ],
  },
  {
    id: 'branching-account',
    description: 'account hub branching to profile, security, billing',
    graph: graph(
      [
        node(`${SHOP}/account`),
        node(`${SHOP}/account/profile`, { formFields: [field({ name: 'displayName' })] }),
        node(`${SHOP}/account/security`, {
          formFields: [field({ name: 'password', required: true })],
        }),
        node(`${SHOP}/account/billing`),
      ],
      [
        edge(`${SHOP}/account`, `${SHOP}/account/profile`, 'Profile'),
        edge(`${SHOP}/account`, `${SHOP}/account/security`, 'Security'),
        edge(`${SHOP}/account`, `${SHOP}/account/billing`, 'Billing'),
      ]
    ),
    expectedJourneys: [
      [`${SHOP}/account`, `${SHOP}/account/profile`],
      [`${SHOP}/account`, `${SHOP}/account/security`],
      [`${SHOP}/account`, `${SHOP}/account/billing`],
    ],
  },
  {
    id: 'form-heavy-admin',
    description: 'admin pages whose value is in their forms, not their links',
    graph: graph(
      [
        node(`${ADMIN}/users`, {
          formFields: [
            field({ name: 'email', type: 'email', required: true }),
            field({ name: 'role', type: 'select', options: ['admin', 'viewer'] }),
          ],
          apiEndpoints: [
            { endpoint: `${ADMIN}/api/users`, method: 'POST', status: 201, context: 'form_submit' },
          ],
          formOutcomes: [
            {
              filledFields: ['#email'],
              submitSelector: '#invite',
              result: 'success',
              resultMessage: 'Invitation sent',
            },
          ],
        }),
        node(`${ADMIN}/settings`, {
          formFields: [field({ name: 'retentionDays', type: 'number', required: true })],
        }),
      ],
      [edge(`${ADMIN}/users`, `${ADMIN}/settings`, 'Settings')]
    ),
    // A form page is a journey in its own right even with no outgoing edge.
    expectedJourneys: [[`${ADMIN}/users`], [`${ADMIN}/settings`]],
  },
  {
    id: 'cyclic-navigation',
    description: 'pages that link back to each other — must not loop forever',
    graph: graph(
      [node(`${SHOP}/a`), node(`${SHOP}/b`), node(`${SHOP}/c`)],
      [
        edge(`${SHOP}/a`, `${SHOP}/b`, 'To B'),
        edge(`${SHOP}/b`, `${SHOP}/c`, 'To C'),
        edge(`${SHOP}/c`, `${SHOP}/a`, 'Back to A'),
      ]
    ),
    expectedJourneys: [[`${SHOP}/a`, `${SHOP}/b`]],
  },
];

// ── Scoring ─────────────────────────────────────────────────────────────────

/**
 * Every identifier a flow step refers to, in order.
 *
 * Both URLs and TITLES are collected. An earlier version of this matcher only
 * accepted `http`-prefixed values and scored completeness at 22% — because the
 * enumerator names a navigation destination by its page TITLE ("Verify shipping
 * loaded"), not its URL. The enumerator was right; the scoring was measuring the
 * wrong field. Worth recording, since a benchmark that penalises correct
 * behaviour is as dangerous as one that flatters it.
 */
function stepTokens(flow: {
  steps?: Array<{ target?: string; value?: string }>;
}): string[] {
  const tokens: string[] = [];
  for (const step of flow.steps ?? []) {
    for (const v of [step.value, step.target]) {
      if (v) tokens.push(v);
    }
  }
  return tokens;
}

/**
 * Does any flow cover this journey?
 *
 * A journey is given as URLs; a step may name a page by URL or by title, so
 * expected URLs are resolved to both forms before matching in order.
 */
function journeyCovered(
  flows: Array<{ steps?: Array<{ target?: string; value?: string }> }>,
  journey: string[],
  urlToTitle: ReadonlyMap<string, string>
): boolean {
  const accepted = journey.map((url) => {
    const forms = new Set<string>([url]);
    const title = urlToTitle.get(url);
    if (title) forms.add(title);
    return forms;
  });

  return flows.some((flow) => {
    const tokens = stepTokens(flow);
    let i = 0;
    for (const token of tokens) {
      if (accepted[i].has(token)) i++;
      if (i === accepted.length) return true;
    }
    return false;
  });
}

/** url → title, so a journey can be matched in either form. */
function titleMap(g: InteractionGraph): Map<string, string> {
  return new Map(g.nodes.map((n) => [n.url, n.title ?? '']));
}

/**
 * A flow that can never be executed.
 *
 * Empty steps, or steps with neither an action nor a target — those are noise a
 * user has to wade through, and the reason "more flows" is not the same as
 * "better flows".
 */
function isSpurious(flow: { steps?: Array<{ action?: string; target?: string; value?: string }> }): boolean {
  const steps = flow.steps ?? [];
  if (steps.length === 0) return true;
  return steps.every((s) => !s.action && !s.target && !s.value);
}

describe('flow enumeration quality on fixture graphs', () => {
  it('given_the_fixture_apps_then_it_meets_the_flow_quality_gate', () => {
    let expectedTotal = 0;
    let coveredTotal = 0;
    let spuriousTotal = 0;
    let duplicateTotal = 0;
    let flowTotal = 0;
    const lines: string[] = [];

    for (const fixture of FIXTURES) {
      const flows = enumerateSkeletons(fixture.graph);
      const deduped = dedupeBySignature(flows);

      const titles = titleMap(fixture.graph);
      const covered = fixture.expectedJourneys.filter((j) => journeyCovered(flows, j, titles));
      const spurious = flows.filter(isSpurious);
      const duplicates = flows.length - deduped.length;

      expectedTotal += fixture.expectedJourneys.length;
      coveredTotal += covered.length;
      spuriousTotal += spurious.length;
      duplicateTotal += duplicates;
      flowTotal += flows.length;

      const missing = fixture.expectedJourneys.filter((j) => !journeyCovered(flows, j, titles));
      lines.push(
        `  ${missing.length === 0 ? '✓' : '✗'} ${fixture.id.padEnd(20)} ` +
          `${covered.length}/${fixture.expectedJourneys.length} journeys · ` +
          `${flows.length} flows · ${spurious.length} spurious · ${duplicates} dupes`
      );
      for (const m of missing) lines.push(`      MISSING: ${m.join(' → ')}`);
    }

    const completeness = expectedTotal === 0 ? 1 : coveredTotal / expectedTotal;
    const spuriousRate = flowTotal === 0 ? 0 : spuriousTotal / flowTotal;

    // eslint-disable-next-line no-console
    console.log(
      [
        '',
        '── Flow generation quality ───────────────────────────────────',
        `Fixture apps:    ${FIXTURES.length}`,
        `Flows enumerated:${String(flowTotal).padStart(4)}  (deterministic, zero tokens)`,
        `Completeness:    ${(completeness * 100).toFixed(0)}%  (${coveredTotal}/${expectedTotal} expected journeys)`,
        `Spurious rate:   ${(spuriousRate * 100).toFixed(0)}%`,
        `Duplicates:      ${duplicateTotal}`,
        '',
        ...lines,
        '',
      ].join('\n')
    );

    // Completeness is the claim the graph-first design makes; hold it to it.
    expect(completeness).toBeGreaterThanOrEqual(0.9);
    // Noise is what makes "more flows" worthless.
    expect(spuriousTotal, 'flows with no executable step').toBe(0);
    // Structural dedup is the merge strategy's whole basis.
    expect(duplicateTotal, 'identical journeys emitted more than once').toBe(0);
  });

  it('given_a_linear_chain_then_every_prefix_of_the_journey_is_enumerated', () => {
    // The completeness claim in concrete form: a 4-page checkout should yield the
    // 1-hop, 2-hop and 3-hop journeys, so a suite covers reaching each stage — not
    // just the final one.
    const checkout = FIXTURES.find((f) => f.id === 'linear-checkout')!;
    const names = enumerateSkeletons(checkout.graph).map((f) => f.name ?? '');
    expect(names.some((n) => /cart → shipping$/.test(n))).toBe(true);
    expect(names.some((n) => /cart → shipping → payment$/.test(n))).toBe(true);
    expect(names.some((n) => /cart → shipping → payment → confirmation$/.test(n))).toBe(true);
  });

  it('given_a_cyclic_graph_then_enumeration_terminates_and_stays_bounded', () => {
    // A graph-first enumerator that follows cycles would hang or explode. This is
    // the failure mode the deterministic approach most needs guarding.
    const cyclic = FIXTURES.find((f) => f.id === 'cyclic-navigation')!;
    const flows = enumerateSkeletons(cyclic.graph);
    expect(flows.length).toBeGreaterThan(0);
    expect(flows.length).toBeLessThan(200);
    for (const f of flows) expect((f.steps ?? []).length).toBeLessThan(50);
  });

  it('given_a_form_page_with_no_outgoing_links_then_it_still_yields_a_flow', () => {
    // Its value is the form, not the navigation. A link-only enumerator would
    // silently skip the most testable pages in the app.
    const adminOnly = graph(
      [
        node(`${ADMIN}/users`, {
          formFields: [field({ name: 'email', type: 'email', required: true })],
        }),
      ],
      []
    );
    expect(enumerateSkeletons(adminOnly).length).toBeGreaterThan(0);
  });

  it('given_an_empty_graph_then_it_returns_nothing_rather_than_throwing', () => {
    expect(enumerateSkeletons(graph([], []))).toEqual([]);
    expect(enumerateSkeletons(undefined)).toEqual([]);
  });

  it('given_the_same_graph_twice_then_enumeration_is_deterministic', () => {
    // The property the whole design rests on: completeness is a traversal
    // property, so the same graph must always yield the same flows.
    const a = enumerateSkeletons(FIXTURES[0].graph).map((f) => flowSignature(f.steps ?? []));
    const b = enumerateSkeletons(FIXTURES[0].graph).map((f) => flowSignature(f.steps ?? []));
    expect(a).toEqual(b);
  });

  it('given_duplicate_flows_then_structural_dedup_collapses_them', () => {
    const flows = enumerateSkeletons(FIXTURES[0].graph);
    const doubled = dedupeBySignature([...flows, ...flows]);
    expect(doubled.length).toBe(dedupeBySignature(flows).length);
  });
});
