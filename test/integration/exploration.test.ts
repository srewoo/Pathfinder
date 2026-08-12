/**
 * Integration test: Autonomous exploration (exploreApp)
 *
 * Focuses on the behaviours fixed for full-app vs single-page coverage:
 *  - single-page mode (maxDepth 0) still CLICKS and discovers modals/forms
 *    (previously skipped by an early `depth >= maxDepth` continue)
 *  - depth gating: links beyond maxDepth are recorded as edges but not navigated
 *  - read-only by default: forms are NOT submitted unless submitForms is set
 *  - exploration runs in a dedicated tab that is cleaned up
 *
 * Everything below the explorer (page scanner, messaging, CDP, auth, a11y) is
 * mocked. The interaction-graph is REAL (only persistence is stubbed) so graph
 * assertions reflect genuine addNode/addEdge behaviour.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InteractiveElement } from '../../src/storage/schemas';

const ORIGIN = 'https://app.test';
const START = 'https://app.test/';

vi.mock('../../src/messaging/messenger', () => ({
  sendToContentScript: vi.fn().mockResolvedValue({ payload: { hasError: false, hasSuccess: false } }),
  getActiveTabId: vi.fn().mockResolvedValue(1),
}));

vi.mock('../../src/core/explorer/page-scanner', () => {
  // The explorer calls partitionExplorationTargets; these tests drive
  // selectExplorationTargets. Delegating keeps one stub as the single source of
  // truth for "what is on this page" instead of two that can disagree.
  const selectExplorationTargets = vi.fn().mockReturnValue([]);
  return {
  scanPage: vi.fn().mockResolvedValue([]),
  scanFormFields: vi.fn().mockResolvedValue([]),
  scanPageLinks: vi.fn().mockResolvedValue([]),
  scanPageMetadata: vi.fn().mockResolvedValue({ headings: [] }),
  // Returns the elements seen during the reveal sweep — an ARRAY, always.
  revealPageContent: vi.fn().mockResolvedValue([]),
  getPageSnapshot: vi.fn().mockResolvedValue({ url: START, title: 'Home' }),
  selectExplorationTargets,
  partitionExplorationTargets: vi.fn((els: unknown, visited: unknown, opts: unknown) => ({
    targets: (selectExplorationTargets as (a: unknown, b: unknown, c: unknown) => unknown[])(els, visited, opts),
    sessionEnding: [],
    destructive: [],
    unidentified: [],
    overCap: 0,
    rowNavigationsSkipped: 0,
  })),
  // Selection/bulk-action discovery is covered on its own in
  // test/unit/core/selection-explorer.test.ts; neutralised here.
  selectToggleTargets: vi.fn().mockReturnValue([]),
  detectModal: vi.fn().mockResolvedValue({ found: false }),
  scanPageActions: vi.fn().mockResolvedValue([]),
  scanDataTables: vi.fn().mockResolvedValue([]),
  scanPageType: vi.fn().mockResolvedValue({ pageType: 'other', isErrorPage: false }),
  scanFieldErrors: vi.fn().mockResolvedValue([]),
  scanWizardSteps: vi.fn().mockResolvedValue([]),
  scanConditionalFields: vi.fn().mockResolvedValue([]),
  };
});

// Execution now routes through the CDP driver (fix.md §3), not the content
// script. Actions are asserted against this mock instead of EXECUTE_ACTION
// messages.
vi.mock('../../src/core/step-executor', () => ({
  executeStep: vi.fn().mockResolvedValue({ success: true }),
  canExecuteStep: vi.fn().mockReturnValue(true),
  releaseTab: vi.fn(),
  // The explorer reads the post-click URL through the evaluator now (a full DOM
  // snapshot per click dominated the cost of a page). Rejecting here exercises the
  // snapshot fallback, which is what the URL assertions below rely on.
  evaluateInTab: vi.fn().mockRejectedValue(new Error('no evaluator in this harness')),
}));
vi.mock('../../src/core/explorer/action-ranker', () => ({ getAgentActions: vi.fn().mockResolvedValue([]) }));
vi.mock('../../src/core/explorer/spa-detector', () => ({ detectSPARoutes: vi.fn().mockResolvedValue([]) }));

// CDP unavailable — exercises the non-CDP path (no HAR / a11y).
vi.mock('../../src/core/cdp/cdp-client', () => ({
  attach: vi.fn().mockRejectedValue(new Error('no cdp')),
  detach: vi.fn().mockResolvedValue(undefined),
  isAttached: vi.fn().mockReturnValue(false),
  startHARCapture: vi.fn().mockResolvedValue(undefined),
  getHAREntries: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/core/executor/auth-manager', () => ({
  ensureAuthenticated: vi.fn().mockResolvedValue({ authenticated: true, method: 'preset' }),
}));

vi.mock('../../src/core/analysis/accessibility-audit', () => ({
  runAccessibilityAudit: vi.fn().mockResolvedValue({ issues: [], summary: { total: 0, critical: 0, serious: 0 } }),
}));

// Checkpoint persistence is stubbed so a resume can be driven deterministically.
// `loadCheckpoint` returning undefined (the default) is the "no checkpoint" case.
vi.mock('../../src/storage/checkpoint-storage', () => ({
  loadCheckpoint: vi.fn().mockResolvedValue(undefined),
  persistCheckpoint: vi.fn().mockResolvedValue(undefined),
  clearCheckpoint: vi.fn().mockResolvedValue(undefined),
}));

// Real interaction-graph, but stub persistence (no IndexedDB writes).
vi.mock('../../src/core/explorer/interaction-graph', async (importActual) => {
  const actual = await importActual<typeof import('../../src/core/explorer/interaction-graph')>();
  return {
    ...actual,
    loadGraph: vi.fn().mockResolvedValue(null),
    saveGraph: vi.fn().mockResolvedValue(undefined),
    saveGraphIncremental: vi.fn().mockResolvedValue(undefined),
    saveGraphSnapshot: vi.fn().mockResolvedValue(undefined),
  };
});

// Chrome mock that drives navigateToUrl's onUpdated listener to "complete".
function makeChromeMock() {
  const updatedListeners: Array<(id: number, info: { status: string }) => void> = [];
  return {
    updatedListeners,
    tabs: {
      get: vi.fn().mockResolvedValue({ id: 1, url: START }),
      create: vi.fn().mockResolvedValue({ id: 99 }),
      remove: vi.fn().mockResolvedValue(undefined),
      update: vi.fn((tabId: number, _props: unknown) => {
        // Fire "complete" on the next microtask so navigateToUrl resolves fast.
        queueMicrotask(() => updatedListeners.forEach((l) => l(tabId, { status: 'complete' })));
        return Promise.resolve();
      }),
      onUpdated: {
        addListener: vi.fn((l: (id: number, info: { status: string }) => void) => updatedListeners.push(l)),
        removeListener: vi.fn((l: (id: number, info: { status: string }) => void) => {
          const i = updatedListeners.indexOf(l);
          if (i >= 0) updatedListeners.splice(i, 1);
        }),
      },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  };
}

const el = (partial: Partial<InteractiveElement>): InteractiveElement =>
  ({ selector: 'x', tag: 'button', visible: true, ...partial } as unknown as InteractiveElement);

const { exploreApp, computeStructureFingerprint } = await import('../../src/core/explorer/explorer-agent');
const scanner = await import('../../src/core/explorer/page-scanner');
const { sendToContentScript } = await import('../../src/messaging/messenger');
const { executeStep } = await import('../../src/core/step-executor');

/** Selectors the explorer actually clicked, via the driver step-runner. */
function clickedSelectors(): string[] {
  return vi.mocked(executeStep).mock.calls
    .filter(([step]) => step?.action === 'click')
    .map(([step]) => step.selector ?? '');
}
const graphMod = await import('../../src/core/explorer/interaction-graph');
const checkpointStore = await import('../../src/storage/checkpoint-storage');
const { createCheckpoint, hashOptions } = await import('../../src/core/explorer/exploration-checkpoint');

describe('exploreApp — single-page vs full-app coverage', () => {
  let chromeMock: ReturnType<typeof makeChromeMock>;

  beforeEach(() => {
    vi.clearAllMocks();
    chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    // Re-apply defaults cleared above.
    vi.mocked(scanner.scanPage).mockResolvedValue([]);
    vi.mocked(scanner.scanFormFields).mockResolvedValue([]);
    vi.mocked(scanner.scanPageLinks).mockResolvedValue([]);
    vi.mocked(scanner.scanPageMetadata).mockResolvedValue({ headings: [] });
    vi.mocked(scanner.getPageSnapshot).mockResolvedValue({ url: START, title: 'Home' } as never);
    vi.mocked(scanner.selectExplorationTargets).mockReturnValue([]);
    vi.mocked(scanner.detectModal).mockResolvedValue({ found: false } as never);
    vi.mocked(scanner.scanPageType).mockResolvedValue({ pageType: 'other', isErrorPage: false } as never);
    vi.mocked(sendToContentScript).mockResolvedValue({ payload: { hasError: false, hasSuccess: false } } as never);
  });

  it('given single-page mode (maxDepth 0) when a click opens a modal then the modal is captured', async () => {
    vi.mocked(scanner.scanPage).mockResolvedValue([el({ selector: '#open', text: 'New' })]);
    vi.mocked(scanner.selectExplorationTargets).mockReturnValue([{ selector: '#open', text: 'New' } as never]);
    // Click does not navigate (url stays the same) → modal-detection path.
    vi.mocked(scanner.getPageSnapshot).mockResolvedValue({ url: START, title: 'Home' } as never);
    vi.mocked(scanner.detectModal).mockResolvedValue({ found: true, title: 'Create Item', formFields: [] } as never);

    const { graph } = await exploreApp({
      startUrl: START, maxDepth: 0, maxPages: 1, agentMode: false, useDedicatedTab: false,
    });

    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].modals?.some((m) => m.title === 'Create Item')).toBe(true);
    // The explorer actually clicked the element (interaction happened on the single page).
    expect(vi.mocked(executeStep)).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'click', selector: '#open' }),
      1
    );
  });

  it('given single-page mode (maxDepth 0) then pure navigation links are skipped but buttons and tabs ARE clicked', async () => {
    vi.mocked(scanner.scanPage).mockResolvedValue([
      el({ selector: '#nav', tag: 'a', text: 'Go' }),
      el({ selector: '#menu', tag: 'div', role: 'menuitem', text: 'Menu' }),
      el({ selector: '#tab', tag: 'div', role: 'tab', text: 'Transcript' }),
      el({ selector: '#btn', tag: 'button', text: 'Open' }),
    ]);
    vi.mocked(scanner.selectExplorationTargets).mockReturnValue([
      { selector: '#nav' }, { selector: '#menu' }, { selector: '#tab' }, { selector: '#btn' },
    ] as never);

    await exploreApp({ startUrl: START, maxDepth: 0, maxPages: 1, agentMode: false, useDedicatedTab: false });

    const clicked = clickedSelectors();

    expect(clicked).toContain('#btn');      // in-place action → clicked
    expect(clicked).toContain('#tab');      // feature tab (query-param view) → clicked
    expect(clicked).not.toContain('#nav');  // navigation link → skipped
    expect(clicked).not.toContain('#menu'); // menu item (navigation) → skipped
  });

  it('given anchor links whose href only changes the query param then they are captured as in-page tabs (not nav edges)', async () => {
    vi.mocked(scanner.scanPageLinks).mockResolvedValue([
      { url: `${START}?aiFeatureTab=overview`, text: 'Overview' },
      { url: `${START}?aiFeatureTab=transcript`, text: 'Transcript' },
      { url: `${ORIGIN}/learner/home`, text: 'Home' }, // real navigation
    ] as never);

    const { graph } = await exploreApp({
      startUrl: START, maxDepth: 0, maxPages: 1, agentMode: false, useDedicatedTab: false,
    });

    const tabs = graph.nodes[0].tabs ?? [];
    expect(tabs.map((t) => t.label).sort()).toEqual(['Overview', 'Transcript']);
    // The same-page query-param links are NOT recorded as navigation edges...
    expect(graph.edges.some((e) => e.to.includes('aiFeatureTab'))).toBe(false);
    // ...but a genuine navigation link still is.
    expect(graph.edges.some((e) => e.to === `${ORIGIN}/learner/home`)).toBe(true);
  });

  it('given a click that changes only a query param then it is recorded as an in-page tab (not a navigated page)', async () => {
    const tabUrl = `${START}?aiFeatureTab=transcript`;
    vi.mocked(scanner.scanPage).mockResolvedValue([el({ selector: '#transcript', role: 'tab', text: 'Transcript' })]);
    vi.mocked(scanner.selectExplorationTargets).mockReturnValue([{ selector: '#transcript' } as never]);
    // First snapshot = base page; after the click the URL gains a query param.
    vi.mocked(scanner.getPageSnapshot)
      .mockResolvedValueOnce({ url: START, title: 'Home' } as never) // page scan
      .mockResolvedValue({ url: tabUrl, title: 'Home' } as never);   // after click

    const { graph } = await exploreApp({
      startUrl: START, maxDepth: 0, maxPages: 1, agentMode: false, useDedicatedTab: false,
    });

    // The tab is captured on the node as an in-page view...
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].tabs?.some((t) => t.url === tabUrl)).toBe(true);
    // ...and it was NOT treated as a separate navigated page.
    expect(graph.nodes.map((n) => n.url)).not.toContain(tabUrl);
  });

  it('given exhaustiveStartPage then it clicks ALL targets on the anchored page', async () => {
    vi.mocked(scanner.scanPage).mockResolvedValue([
      el({ selector: '#a', tag: 'button', text: 'A' }),
      el({ selector: '#b', tag: 'button', text: 'B' }),
      el({ selector: '#c', tag: 'button', text: 'C' }),
    ]);
    vi.mocked(scanner.selectExplorationTargets).mockReturnValue([
      { selector: '#a' }, { selector: '#b' }, { selector: '#c' },
    ] as never);

    await exploreApp({ startUrl: START, maxDepth: 0, maxPages: 1, agentMode: false, useDedicatedTab: false, exhaustiveStartPage: true });

    const clicked = clickedSelectors();
    expect(clicked).toEqual(expect.arrayContaining(['#a', '#b', '#c']));
  }, 20000);

  it('given exhaustiveStartPage and a click that reveals a dropdown then the revealed items are also clicked', async () => {
    vi.mocked(scanner.scanPage)
      .mockResolvedValueOnce([el({ selector: '#copy', tag: 'button', text: 'Copy summary' })]) // initial page scan
      .mockResolvedValue([ // reveal re-scans expose the opened menu
        el({ selector: '#copy', tag: 'button', text: 'Copy summary' }),
        el({ selector: '#copy-summary', tag: 'div', role: 'menuitem', text: 'Copy summary' }),
        el({ selector: '#copy-all', tag: 'div', role: 'menuitem', text: 'Copy all' }),
      ]);
    vi.mocked(scanner.selectExplorationTargets).mockReturnValue([{ selector: '#copy' }] as never);
    vi.mocked(scanner.getPageSnapshot).mockResolvedValue({ url: START, title: 'Home' } as never);
    vi.mocked(scanner.detectModal).mockResolvedValue({ found: false } as never);

    await exploreApp({ startUrl: START, maxDepth: 0, maxPages: 1, agentMode: false, useDedicatedTab: false, exhaustiveStartPage: true });

    const clicked = clickedSelectors();
    expect(clicked).toContain('#copy');          // the trigger
    expect(clicked).toContain('#copy-summary');  // revealed menu item
    expect(clicked).toContain('#copy-all');      // revealed menu item
  }, 20000);

  it('given read-only default when a form is present then it is NOT submitted', async () => {
    vi.mocked(scanner.scanPage).mockResolvedValue([el({ selector: '#submit', tag: 'button', type: 'submit' })]);
    vi.mocked(scanner.scanFormFields).mockResolvedValue([
      { selector: '#email', type: 'email', required: true } as never,
    ]);

    await exploreApp({ startUrl: START, maxDepth: 0, maxPages: 1, agentMode: false, useDedicatedTab: false });

    // No form-submit action should ever be dispatched in read-only mode.
    const submitted = vi.mocked(executeStep).mock.calls.some(([step]) =>
      step?.description?.includes('form submit'));
    expect(submitted).toBe(false);
  });

  it('given submitForms enabled when a form is present then it IS submitted', async () => {
    vi.mocked(scanner.scanPage).mockResolvedValue([el({ selector: '#submit', tag: 'button', type: 'submit' })]);
    vi.mocked(scanner.scanFormFields).mockResolvedValue([
      { selector: '#email', type: 'email', required: true } as never,
    ]);

    await exploreApp({ startUrl: START, maxDepth: 0, maxPages: 1, agentMode: false, useDedicatedTab: false, submitForms: true });

    const submitted = vi.mocked(executeStep).mock.calls.some(([step]) =>
      step?.description?.includes('form submit'));
    expect(submitted).toBe(true);
  }, 20000);

  it('given maxDepth 0 when a link is found then an edge is recorded but the page is NOT navigated', async () => {
    vi.mocked(scanner.scanPageLinks).mockResolvedValue([{ url: `${ORIGIN}/other`, text: 'Other' } as never]);

    const { graph } = await exploreApp({
      startUrl: START, maxDepth: 0, maxPages: 5, agentMode: false, useDedicatedTab: false,
    });

    // Only the start page is processed (depth budget prevents following links)...
    expect(graph.nodes).toHaveLength(1);
    // ...but the link edge is still recorded for a complete graph.
    expect(graph.edges.some((e) => e.to === `${ORIGIN}/other` && e.action === 'link')).toBe(true);
  });

  it('given maxDepth 1 when a link is found then the destination page IS explored', async () => {
    vi.mocked(scanner.scanPageLinks)
      .mockResolvedValueOnce([{ url: `${ORIGIN}/other`, text: 'Other' } as never])
      .mockResolvedValue([]);
    vi.mocked(scanner.getPageSnapshot)
      .mockResolvedValueOnce({ url: START, title: 'Home' } as never)
      .mockResolvedValue({ url: `${ORIGIN}/other`, title: 'Other' } as never);

    const { graph } = await exploreApp({
      startUrl: START, maxDepth: 1, maxPages: 5, agentMode: false, useDedicatedTab: false,
    });

    const urls = graph.nodes.map((n) => n.url);
    expect(urls).toContain(START);
    expect(urls).toContain(`${ORIGIN}/other`);
  });

  it('given useDedicatedTab when exploring then a background tab is created and cleaned up', async () => {
    await exploreApp({ startUrl: START, maxDepth: 0, maxPages: 1, agentMode: false, useDedicatedTab: true });

    expect(chromeMock.tabs.create).toHaveBeenCalled();
    expect(chromeMock.tabs.remove).toHaveBeenCalledWith(99);
  });
});

describe('exploreApp — fresh re-scan, stale pruning, change detection', () => {
  let chromeMock: ReturnType<typeof makeChromeMock>;

  /** Build a seeded graph via the REAL graph functions so module indices match. */
  function seedGraph(nodes: Array<{ url: string; title: string; structureHash?: string }>) {
    const g = graphMod.createGraph();
    for (const n of nodes) {
      const node = graphMod.addNode(g, n.url, n.title, 1);
      if (n.structureHash) node.structureHash = n.structureHash;
    }
    return g;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    vi.mocked(scanner.scanPage).mockResolvedValue([]);
    vi.mocked(scanner.scanFormFields).mockResolvedValue([]);
    vi.mocked(scanner.scanPageLinks).mockResolvedValue([]);
    vi.mocked(scanner.scanPageMetadata).mockResolvedValue({ headings: [] });
    vi.mocked(scanner.getPageSnapshot).mockResolvedValue({ url: START, title: 'Home' } as never);
    vi.mocked(scanner.selectExplorationTargets).mockReturnValue([]);
    vi.mocked(scanner.detectModal).mockResolvedValue({ found: false } as never);
    vi.mocked(scanner.scanPageType).mockResolvedValue({ pageType: 'other', isErrorPage: false } as never);
    vi.mocked(sendToContentScript).mockResolvedValue({ payload: { hasError: false, hasSuccess: false } } as never);
  });

  it('given fresh=true when re-scanning then a previously-mapped page IS re-visited (not skipped)', async () => {
    vi.mocked(graphMod.loadGraph).mockResolvedValue(seedGraph([{ url: START, title: 'Home' }]));
    vi.mocked(scanner.scanPage).mockResolvedValue([el({ selector: '#x' })]);

    await exploreApp({ startUrl: START, maxDepth: 0, maxPages: 1, agentMode: false, useDedicatedTab: false, fresh: true });

    // Re-scanned: scanPage ran for the existing page (in default mode it would be skipped).
    expect(vi.mocked(scanner.scanPage)).toHaveBeenCalled();
  });

  it('given fresh=true when a mapped page is no longer reachable then it is pruned (and a snapshot saved)', async () => {
    vi.mocked(graphMod.loadGraph).mockResolvedValue(seedGraph([
      { url: START, title: 'Home' },
      { url: `${ORIGIN}/gone`, title: 'Removed page' },
    ]));
    // Start page links to nothing → /gone is never re-seen this run.
    vi.mocked(scanner.scanPageLinks).mockResolvedValue([]);

    const { graph } = await exploreApp({ startUrl: START, maxDepth: 0, maxPages: 5, agentMode: false, useDedicatedTab: false, fresh: true });

    const urls = graph.nodes.map((n) => n.url);
    expect(urls).toContain(START);
    expect(urls).not.toContain(`${ORIGIN}/gone`); // pruned
    expect(vi.mocked(graphMod.saveGraphSnapshot)).toHaveBeenCalled(); // reversible
  });

  it('given fresh=true and an unchanged structure then click/form interaction is SKIPPED', async () => {
    const elements = [el({ selector: '#open', text: 'New' })];
    const hash = computeStructureFingerprint(elements, []);
    vi.mocked(graphMod.loadGraph).mockResolvedValue(seedGraph([{ url: START, title: 'Home', structureHash: hash }]));
    vi.mocked(scanner.scanPage).mockResolvedValue(elements);
    // If interaction ran, this target would be clicked.
    vi.mocked(scanner.selectExplorationTargets).mockReturnValue([{ selector: '#open' } as never]);

    await exploreApp({ startUrl: START, maxDepth: 0, maxPages: 1, agentMode: false, useDedicatedTab: false, fresh: true });

    // No click action dispatched because the structure fingerprint matched.
    const clicked = clickedSelectors().length > 0;
    expect(clicked).toBe(false);
  });

  it('given re-explore of an existing page (maxDepth 0) then it refreshes that node WITHOUT re-walking or duplicating neighbors', async () => {
    vi.mocked(graphMod.loadGraph).mockResolvedValue(seedGraph([
      { url: START, title: 'Home' },
      { url: `${ORIGIN}/neighbor`, title: 'Neighbor' },
    ]));
    // The re-explored page links to an existing neighbor.
    vi.mocked(scanner.scanPageLinks).mockResolvedValue([{ url: `${ORIGIN}/neighbor`, text: 'Neighbor' } as never]);

    const { graph } = await exploreApp({
      startUrl: START, maxDepth: 0, maxPages: 1, reexplorePage: true, agentMode: false, useDedicatedTab: false,
    });

    // Only the start page was re-scanned — the neighbor is NOT re-walked.
    expect(vi.mocked(scanner.scanPage)).toHaveBeenCalledTimes(1);
    // No duplicates: still exactly the two original pages.
    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes.map((n) => n.url).sort()).toEqual([`${ORIGIN}/neighbor`, START].sort());
  });

  it('given fresh=true and a CHANGED structure then interaction runs (page is clicked)', async () => {
    vi.mocked(graphMod.loadGraph).mockResolvedValue(seedGraph([{ url: START, title: 'Home', structureHash: 'stale-hash' }]));
    vi.mocked(scanner.scanPage).mockResolvedValue([el({ selector: '#open', text: 'New' })]);
    vi.mocked(scanner.selectExplorationTargets).mockReturnValue([{ selector: '#open' } as never]);

    await exploreApp({ startUrl: START, maxDepth: 0, maxPages: 1, agentMode: false, useDedicatedTab: false, fresh: true });

    const clicked = clickedSelectors().length > 0;
    expect(clicked).toBe(true);
  });
});

describe('exploreApp — coverage / health reporting', () => {
  let chromeMock: ReturnType<typeof makeChromeMock>;

  beforeEach(() => {
    vi.clearAllMocks();
    chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    vi.mocked(scanner.scanPage).mockResolvedValue([]);
    vi.mocked(scanner.scanFormFields).mockResolvedValue([]);
    vi.mocked(scanner.scanPageLinks).mockResolvedValue([]);
    vi.mocked(scanner.scanPageMetadata).mockResolvedValue({ headings: [] });
    vi.mocked(scanner.getPageSnapshot).mockResolvedValue({ url: START, title: 'Home' } as never);
    vi.mocked(scanner.selectExplorationTargets).mockReturnValue([]);
    vi.mocked(scanner.detectModal).mockResolvedValue({ found: false } as never);
    vi.mocked(scanner.scanPageType).mockResolvedValue({ pageType: 'other', isErrorPage: false } as never);
    vi.mocked(sendToContentScript).mockResolvedValue({ payload: { hasError: false, hasSuccess: false } } as never);
    vi.mocked(graphMod.loadGraph).mockResolvedValue(undefined);
  });

  it('given a null page snapshot when scanning then it is counted as a SCAN FAILURE (not an empty page)', async () => {
    // Content script never answers → snapshot null on both the initial read and
    // the one retry. This must be distinguishable from a genuinely empty page.
    vi.mocked(scanner.getPageSnapshot).mockResolvedValue(null);

    const { graph, coverage } = await exploreApp({
      startUrl: START, maxDepth: 0, maxPages: 1, agentMode: false, useDedicatedTab: false,
    });

    expect(coverage.pagesFailed).toBe(1);
    expect(coverage.pagesScanned).toBe(0);
    expect(graph.nodes).toHaveLength(0); // no node created for a failed scan
    expect(coverage.warnings.some((w) => w.includes('Scan failed'))).toBe(true);
  });

  it('given a healthy but empty page then it is scanned (NOT a failure)', async () => {
    // Snapshot responds; the page just has no interactive elements.
    vi.mocked(scanner.getPageSnapshot).mockResolvedValue({ url: START, title: 'Home' } as never);
    vi.mocked(scanner.scanPage).mockResolvedValue([]);

    const { graph, coverage } = await exploreApp({
      startUrl: START, maxDepth: 0, maxPages: 1, agentMode: false, useDedicatedTab: false,
    });

    expect(coverage.pagesFailed).toBe(0);
    expect(coverage.pagesScanned).toBe(1);
    expect(graph.nodes).toHaveLength(1);
  });

  it('given a CRAWL run with a link left uncrawled then it is an untested path and coverage < 100%', async () => {
    // maxDepth 1 (crawl scope) so /other is enqueued, but maxPages 1 caps the run
    // before it's visited → discovered edge, never mapped.
    vi.mocked(scanner.scanPageLinks).mockResolvedValue([{ url: `${ORIGIN}/other`, text: 'Other' }] as never);

    const { graph, coverage } = await exploreApp({
      startUrl: START, maxDepth: 1, maxPages: 1, agentMode: false, useDedicatedTab: false,
    });

    expect(graph.edges.some((e) => e.to === `${ORIGIN}/other`)).toBe(true);
    expect(coverage.singlePage).toBe(false);
    expect(coverage.untestedPaths).toBe(1);
    expect(coverage.coverageRatio).toBeCloseTo(0.5); // 1 mapped page, 1 untested path → 50%
  });

  it('given a SINGLE-PAGE run then discovered links are next-steps, not coverage gaps (ratio 100%)', async () => {
    // "This page only" (maxDepth 0): the page is the whole scope. It surfaces
    // links to explore, but a fully-scanned page is 100% coverage — not 3%.
    vi.mocked(scanner.scanPageLinks).mockResolvedValue([
      { url: `${ORIGIN}/a`, text: 'A' },
      { url: `${ORIGIN}/b`, text: 'B' },
    ] as never);

    const { coverage } = await exploreApp({
      startUrl: START, maxDepth: 0, maxPages: 1, agentMode: false, useDedicatedTab: false,
    });

    expect(coverage.singlePage).toBe(true);
    expect(coverage.pagesScanned).toBe(1);
    expect(coverage.untestedPaths).toBe(2);   // reported as "links to explore"
    expect(coverage.coverageRatio).toBe(1);   // the anchored page was fully mapped
    expect(coverage.complete).toBe(true);     // hitting maxPages 1 is completion here, not truncation
  });

  it('given a page that resolves to an error page then it is counted as a BROKEN LINK and not mapped', async () => {
    vi.mocked(scanner.scanPageType).mockResolvedValue({ pageType: 'error', isErrorPage: true, httpStatus: 404 } as never);

    const { graph, coverage } = await exploreApp({
      startUrl: START, maxDepth: 0, maxPages: 1, agentMode: false, useDedicatedTab: false,
    });

    expect(coverage.brokenLinks).toBe(1);
    expect(coverage.pagesScanned).toBe(0);
    expect(graph.nodes).toHaveLength(0);
    expect(coverage.warnings.some((w) => w.includes('Broken/error page'))).toBe(true);
  });
});

describe('exploreApp — resuming an interrupted run (fix.md §4)', () => {
  /**
   * The point of writing checkpoints. Before this was wired, the frontier was
   * persisted on every page and then ignored: every interrupted crawl restarted
   * from the seed, paying the cost of durability for none of the benefit.
   */
  const OPTS = { maxDepth: 2, maxPages: 10, submitForms: false, agentMode: false };

  const checkpointFor = (over: Partial<Parameters<typeof createCheckpoint>[0]> = {}) =>
    createCheckpoint({
      runId: 'explore-prev',
      startUrl: START,
      optionsHash: hashOptions(OPTS),
      frontier: [{ url: `${ORIGIN}/queued`, depth: 1 }],
      visited: [START, `${ORIGIN}/already-done`],
      pagesScanned: 2,
      now: Date.now(),
      ...over,
    });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('chrome', makeChromeMock());
    vi.mocked(scanner.scanPage).mockResolvedValue([]);
    vi.mocked(scanner.scanFormFields).mockResolvedValue([]);
    vi.mocked(scanner.scanPageLinks).mockResolvedValue([]);
    vi.mocked(scanner.scanPageMetadata).mockResolvedValue({ headings: [] });
    vi.mocked(scanner.selectExplorationTargets).mockReturnValue([]);
    vi.mocked(scanner.detectModal).mockResolvedValue({ found: false } as never);
    vi.mocked(scanner.scanPageType).mockResolvedValue({ pageType: 'other', isErrorPage: false } as never);
    // Each navigation reports the URL it was asked for, so scanned pages are
    // distinguishable in the resulting graph.
    vi.mocked(scanner.getPageSnapshot).mockImplementation(async (tabId: number) => {
      void tabId;
      const calls = vi.mocked(chrome.tabs.update).mock.calls;
      const last = calls[calls.length - 1]?.[1] as { url?: string } | undefined;
      return { url: last?.url ?? START, title: 'Page' } as never;
    });
  });

  it('given_a_valid_checkpoint_then_the_frontier_is_resumed_and_visited_pages_are_NOT_rescanned', async () => {
    vi.mocked(checkpointStore.loadCheckpoint).mockResolvedValue(checkpointFor());

    const { graph, coverage } = await exploreApp({
      startUrl: START, ...OPTS, useDedicatedTab: false,
    });

    const scanned = graph.nodes.map((n) => n.url);
    // The queued page was picked up …
    expect(scanned).toContain(`${ORIGIN}/queued`);
    // … and neither page the previous segment already mapped was re-walked.
    expect(scanned).not.toContain(`${ORIGIN}/already-done`);
    expect(coverage.pagesScanned).toBe(1);
  });

  it('given_a_resume_then_it_is_reported_as_a_warning_not_silently', async () => {
    // A resume changes what the coverage numbers mean, so it has to be visible.
    vi.mocked(checkpointStore.loadCheckpoint).mockResolvedValue(checkpointFor());
    const { coverage } = await exploreApp({ startUrl: START, ...OPTS, useDedicatedTab: false });
    expect(coverage.warnings.join(' ')).toMatch(/Resumed from a checkpoint/i);
  });

  it('given_fresh_true_then_the_checkpoint_is_ignored', async () => {
    // "fresh" means re-walk everything; honouring a checkpoint would contradict it.
    vi.mocked(checkpointStore.loadCheckpoint).mockResolvedValue(checkpointFor());
    const { graph } = await exploreApp({
      startUrl: START, ...OPTS, useDedicatedTab: false, fresh: true,
    });
    expect(graph.nodes.map((n) => n.url)).toContain(START);
    expect(vi.mocked(checkpointStore.loadCheckpoint)).not.toHaveBeenCalled();
  });

  it('given_a_checkpoint_for_a_DIFFERENT_start_url_then_it_starts_fresh', async () => {
    vi.mocked(checkpointStore.loadCheckpoint).mockResolvedValue(
      checkpointFor({ startUrl: 'https://other.test/' })
    );
    const { graph, coverage } = await exploreApp({ startUrl: START, ...OPTS, useDedicatedTab: false });
    expect(graph.nodes.map((n) => n.url)).toContain(START);
    expect(coverage.warnings.join(' ')).not.toMatch(/Resumed from a checkpoint/i);
  });

  it('given_changed_options_then_it_starts_fresh_rather_than_mislabelling_coverage', async () => {
    vi.mocked(checkpointStore.loadCheckpoint).mockResolvedValue(
      checkpointFor({ optionsHash: hashOptions({ ...OPTS, submitForms: true }) })
    );
    const { graph } = await exploreApp({ startUrl: START, ...OPTS, useDedicatedTab: false });
    expect(graph.nodes.map((n) => n.url)).toContain(START);
  });

  it('given_a_stale_checkpoint_then_it_starts_fresh', async () => {
    vi.mocked(checkpointStore.loadCheckpoint).mockResolvedValue(
      checkpointFor({ now: Date.now() - 1000 * 60 * 60 * 72 })
    );
    const { graph } = await exploreApp({ startUrl: START, ...OPTS, useDedicatedTab: false });
    expect(graph.nodes.map((n) => n.url)).toContain(START);
  });

  it('given_no_checkpoint_then_the_run_starts_normally', async () => {
    vi.mocked(checkpointStore.loadCheckpoint).mockResolvedValue(undefined);
    const { graph } = await exploreApp({ startUrl: START, ...OPTS, useDedicatedTab: false });
    expect(graph.nodes.map((n) => n.url)).toContain(START);
  });
});

describe('exploreApp — never ends the session', () => {
  /**
   * A logout is not just another destructive click. It invalidates every page the
   * crawl visits afterwards: the crawler lands on the login screen, maps that, and
   * the run keeps reporting pages as explored.
   *
   * Links are ENQUEUED without being clicked, so the click-set classifier never
   * sees them — this is the only place a `/logout` href can be stopped.
   */
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('chrome', makeChromeMock());
    vi.mocked(scanner.scanPage).mockResolvedValue([]);
    vi.mocked(scanner.scanFormFields).mockResolvedValue([]);
    vi.mocked(scanner.scanPageMetadata).mockResolvedValue({ headings: [] });
    vi.mocked(scanner.selectExplorationTargets).mockReturnValue([]);
    vi.mocked(scanner.detectModal).mockResolvedValue({ found: false } as never);
    vi.mocked(scanner.scanPageType).mockResolvedValue({ pageType: 'other', isErrorPage: false } as never);
    vi.mocked(scanner.getPageSnapshot).mockResolvedValue({ url: START, title: 'Home' } as never);
  });

  it('given_a_logout_link_on_the_page_then_it_is_never_enqueued_or_recorded_as_an_edge', async () => {
    vi.mocked(scanner.scanPageLinks).mockResolvedValue([
      { url: `${ORIGIN}/settings`, text: 'Settings' },
      { url: `${ORIGIN}/auth/logout`, text: 'Logout' },
    ]);

    const { graph } = await exploreApp({
      startUrl: START, maxDepth: 1, maxPages: 5, agentMode: false, useDedicatedTab: false,
    });

    const edges = graph.edges.map((e) => e.to);
    expect(edges).toContain(`${ORIGIN}/settings`);
    expect(edges).not.toContain(`${ORIGIN}/auth/logout`);
    expect(graph.nodes.map((n) => n.url)).not.toContain(`${ORIGIN}/auth/logout`);
  });

  it('given_an_unlabelled_logout_link_then_the_URL_alone_is_enough', async () => {
    // An icon-only <a href="/logout"> has no text to match on.
    vi.mocked(scanner.scanPageLinks).mockResolvedValue([
      { url: `${ORIGIN}/users/sign_out`, text: '' },
    ]);
    const { graph } = await exploreApp({
      startUrl: START, maxDepth: 1, maxPages: 5, agentMode: false, useDedicatedTab: false,
    });
    expect(graph.edges.map((e) => e.to)).not.toContain(`${ORIGIN}/users/sign_out`);
  });

  it('given_a_page_whose_path_merely_contains_logout_then_it_is_still_crawled', async () => {
    // False positives here silently drop real content from the map.
    vi.mocked(scanner.scanPageLinks).mockResolvedValue([
      { url: `${ORIGIN}/blog/logout-best-practices`, text: 'Article' },
    ]);
    const { graph } = await exploreApp({
      startUrl: START, maxDepth: 1, maxPages: 5, agentMode: false, useDedicatedTab: false,
    });
    expect(graph.edges.map((e) => e.to)).toContain(`${ORIGIN}/blog/logout-best-practices`);
  });
});
