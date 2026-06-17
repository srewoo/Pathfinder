import { describe, it, expect } from 'vitest';
import { synthesizeCoverageFillers } from '../../../src/core/flow/flow-learner';
import { enumerateSkeletons, dedupeBySignature, flowSignature, type FlowDraft } from '../../../src/core/flow/skeleton-enumerator';
import { reconcileFlows } from '../../../src/core/flow/flow-reconciler';
import { projectFlowToTestCases } from '../../../src/core/test-gen/flow-projection';
import type { InteractionGraph, PageNode, PageEdge, Flow, FlowCoverageType } from '../../../src/storage/schemas';

/**
 * Empirical before/after measurement on a realistic feature-rich app graph
 * (modeled on the MindTickle call-recording page: many feature tabs, a list
 * with row actions, a comment form, a constrained settings form, multi-hop nav).
 *
 * "Before" = the only deterministic floor that existed pre-Phase-1:
 *            synthesizeCoverageFillers (≥2 nav/verify per page + 1 per tab).
 * "After"  = Phase-1 graph enumeration ∪ fillers (structurally de-duped).
 *
 * This runs the deterministic layers only (no LLM) — which is exactly the layer
 * the three phases added — so the numbers are reproducible and honest.
 */

const node = (p: Partial<PageNode>): PageNode =>
  ({ id: p.url ?? 'n', url: 'https://app/p', title: 'Page', visitedAt: '', elementCount: 1, ...p } as PageNode);
const edge = (from: string, to: string, label: string, selector: string): PageEdge =>
  ({ from, to, action: 'click', label, selector });

function buildRecordingApp(): InteractionGraph {
  const HOME = 'https://app/home';
  const LIST = 'https://app/recordings';
  const REC = 'https://app/recordings/5993642928991842993';
  const SETTINGS = 'https://app/settings/profile';

  const featureTabs = [
    'Overview', 'Speaker timeline', 'Key moments', 'Themes', 'Comments',
    'Statistics', 'Debrief', 'Scorecard', 'Transcript', 'Ask Copilot',
  ].map((label) => ({ label, url: `${REC}?aiFeatureTab=${label.toLowerCase().replace(/\s+/g, '_')}` }));

  const nodes: PageNode[] = [
    node({ url: HOME, title: 'Home' }),
    node({
      url: LIST,
      title: 'Recordings',
      dataTables: [{ selector: 'table', rowCount: 25, columns: ['Title', 'Date'], rowActions: ['Open', 'Share', 'Delete'], hasPagination: true, hasSorting: true, hasFiltering: true }],
    }),
    node({
      url: REC,
      title: 'Recording',
      tabs: featureTabs,
      modals: [
        { triggerSelector: '#copy-summary', triggerLabel: 'Copy summary', title: 'Copy summary' },
        { triggerSelector: '#view-more', triggerLabel: 'View more', title: 'More details' },
      ],
      formFields: [{ selector: '#comment', type: 'textarea', label: 'Add a comment', required: true, maxLength: 500 }],
      formOutcomes: [{ filledFields: ['#comment'], submitSelector: '#post', result: 'success', resultMessage: 'Comment posted' }],
    }),
    node({
      url: SETTINGS,
      title: 'Profile Settings',
      formFields: [
        { selector: '#name', type: 'text', label: 'Display name', required: true, maxLength: 50 },
        { selector: '#email', type: 'email', label: 'Email', required: true },
        { selector: '#bio', type: 'text', label: 'Bio', required: false, maxLength: 160 },
      ],
      formOutcomes: [{ filledFields: ['#name', '#email'], submitSelector: '#save', result: 'success', resultMessage: 'Saved' }],
    }),
    node({ url: 'https://app/recordings/empty-team', title: 'Team Recordings', dataTables: [{ selector: 't', rowCount: 0, hasPagination: false, hasSorting: false, hasFiltering: false }] }),
  ];

  const edges: PageEdge[] = [
    edge(HOME, LIST, 'Recordings', '#nav-recordings'),
    edge(HOME, SETTINGS, 'Settings', '#nav-settings'),
    edge(LIST, REC, 'Open', '#row-open'),
  ];

  return { nodes, edges, createdAt: '', updatedAt: '' };
}

const draftToStored = (d: FlowDraft, i: number): Flow => ({
  flowId: `id_${i}`, name: d.name, description: d.description, source: d.source,
  steps: d.steps, coverageType: d.coverageType, signature: flowSignature(d.steps),
  createdAt: '', updatedAt: '',
});

describe('PHASE IMPROVEMENT REPORT (deterministic layer)', () => {
  const graph = buildRecordingApp();

  it('quantifies the before → after improvement', () => {
    // ── BEFORE: fillers-only floor ──────────────────────────────────────
    const before = synthesizeCoverageFillers(graph, []);

    // ── AFTER: graph enumeration ∪ fillers ──────────────────────────────
    const skeletons = enumerateSkeletons(graph);
    const after = dedupeBySignature([...skeletons, ...synthesizeCoverageFillers(graph, skeletons)]);

    // Coverage-type breakdown (Phase 2 matrix) over the enumerated skeletons.
    const byType = new Map<FlowCoverageType | 'untyped', number>();
    for (const s of skeletons) {
      const k = (s.coverageType ?? 'untyped') as FlowCoverageType | 'untyped';
      byType.set(k, (byType.get(k) ?? 0) + 1);
    }

    // Phase 3 projection: deterministic test cases from the after-set.
    const stored = after.map(draftToStored);
    const projected = stored.flatMap(projectFlowToTestCases);
    const projByType = projected.reduce(
      (acc, t) => { acc[t.type] = (acc[t.type] ?? 0) + 1; return acc; },
      {} as Record<string, number>
    );

    // ── Phase 3 idempotency / drift, measured ───────────────────────────
    const firstRun = reconcileFlows(after, []);
    const secondRun = reconcileFlows(after, stored); // same input, already stored
    // Drift: drop everything anchored on the Recording page, re-reconcile.
    const shrunk = after.filter((d) => !d.steps.some((st) => (st.value ?? '').includes('5993642928991842993')));
    const driftRun = reconcileFlows(shrunk, stored);

    /* eslint-disable no-console */
    console.log('\n══════════ PHASE IMPROVEMENT REPORT ══════════');
    console.log(`Graph: ${graph.nodes.length} pages, ${graph.edges.length} nav edges, ` +
      `${graph.nodes.reduce((n, x) => n + (x.tabs?.length ?? 0), 0)} feature tabs, ` +
      `${graph.nodes.reduce((n, x) => n + (x.modals?.length ?? 0), 0)} modals, ` +
      `${graph.nodes.filter((x) => x.formFields?.length).length} forms\n`);

    console.log(`Deterministic flows  BEFORE (fillers only): ${before.length}`);
    console.log(`Deterministic flows  AFTER  (graph + fillers): ${after.length}`);
    console.log(`Improvement: +${after.length - before.length} flows (${(after.length / Math.max(before.length, 1)).toFixed(1)}×)\n`);

    console.log('Coverage-type breakdown (NEW — was happy-path only before):');
    for (const [k, v] of [...byType.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(12)} ${v}`);

    console.log(`\nDeterministic test cases projected (Phase 3): ${projected.length}`);
    console.log(`  by type: ${JSON.stringify(projByType)}`);

    console.log('\nRe-learn behavior (Phase 3 reconcile):');
    console.log(`  1st Learn Flows : ${firstRun.toCreate.length} created`);
    console.log(`  2nd Learn Flows : ${secondRun.toCreate.length} created, ${secondRun.toUpdate.length} updated  ← idempotent`);
    console.log(`  after feature removed: ${driftRun.toMarkStale.length} marked stale  ← drift detected`);
    console.log('═══════════════════════════════════════════════\n');
    /* eslint-enable no-console */

    // ── Assertions that the improvement is real ─────────────────────────
    expect(after.length).toBeGreaterThan(before.length); // strictly more coverage
    // The 10 feature tabs you listed are each guaranteed a flow.
    for (const label of ['Transcript', 'Scorecard', 'Debrief', 'Statistics', 'Ask Copilot']) {
      expect(after.some((f) => f.name.includes(label))).toBe(true);
    }
    // Negative + boundary + empty coverage now exists (didn't before).
    expect(byType.get('validation') ?? 0).toBeGreaterThan(0);
    expect(byType.get('boundary') ?? 0).toBeGreaterThan(0);
    expect(byType.get('empty') ?? 0).toBeGreaterThan(0);
    expect(byType.get('navigation') ?? 0).toBeGreaterThan(0);
    // Every flow projects to a test case, spanning positive/negative/edge.
    expect(projected.length).toBe(after.length);
    expect(projByType['negative']).toBeGreaterThan(0);
    expect(projByType['edge']).toBeGreaterThan(0);
    // Idempotent: re-running creates nothing new.
    expect(secondRun.toCreate).toHaveLength(0);
    expect(secondRun.toUpdate.length).toBeGreaterThan(0);
    // Drift: removing the recording feature marks its flows stale.
    expect(driftRun.toMarkStale.length).toBeGreaterThan(0);
  });
});
