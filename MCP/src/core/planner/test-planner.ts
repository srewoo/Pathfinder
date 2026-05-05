import type { Page } from 'playwright';
import type { AIClientInterface } from '../ai/ai-client.js';
import type {
  TestCase,
  ExecutionPlan,
  ExecutionStep,
  ActionType,
  AssertType,
  InteractionGraph,
  PageNode,
  PageEdge,
} from '../../storage/schemas.js';
import { PROMPTS } from '../ai/prompt-templates.js';
import { searchByText, formatSearchResults } from '../knowledge/vector-search.js';
import { getPageSnapshotFromPage, getAccessibilitySnapshot } from '../../browser/playwright-adapter.js';
import { loadGraph, extractAllFormFields, serializeNavigationMap } from '../explorer/interaction-graph.js';
import { getAllFlows, serializeFlowsForAI } from '../flow/flow-store.js';
import { computePlanHash, getCachedPlan, cachePlan } from './plan-cache.js';
import { testCaseRepo } from '../../storage/repositories/test-case-repo.js';
import { rewriteOrigin, detectGraphOrigin } from '../../environment/url-resolver.js';
import { createLogger } from '../../utils/logger.js';

/** Optional external context that can be injected into planning. */
export interface PlanningContext {
  /** Serialized accessibility tree from CDP */
  accessibilityContext?: string;
  /** Serialized API spec from OpenAPI parser */
  apiContext?: string;
}

const log = createLogger('planner');

/**
 * Convert a test case into an executable plan.
 *
 * @param testCase    - The test case to plan.
 * @param aiClient    - AI client for planning + embeddings.
 * @param page        - The Playwright Page for snapshot capture.
 * @param forceFresh  - If true, skip cache and produce a new plan (used on retry).
 * @param extraContext - Optional additional context (accessibility, API spec).
 * @param targetOrigin - Optional target environment origin (e.g. "https://prod.app.com").
 *                       When provided and different from the graph's origin, all graph
 *                       URLs used during planning are rewritten to this origin.
 */
export async function planTest(
  testCase: TestCase,
  aiClient: AIClientInterface,
  page: Page,
  forceFresh = false,
  extraContext?: PlanningContext,
  targetOrigin?: string
): Promise<ExecutionPlan> {
  const [snapshot, a11yTree] = await Promise.all([
    getPageSnapshotFromPage(page),
    getAccessibilitySnapshot(page),
  ]);
  const pageUrl = snapshot?.url ?? '';
  const testSignature = [
    testCase.id,
    testCase.title,
    testCase.description,
    testCase.executionPresetId ?? '',
    testCase.executionPresetName ?? '',
    testCase.personaLabel ?? '',
    testCase.setupNotes ?? '',
    ...(testCase.setupSteps ?? []),
    ...(testCase.steps ?? []),
  ].join('\n');

  const hash = await computePlanHash(testSignature, pageUrl);

  if (!forceFresh) {
    const cached = await getCachedPlan(hash, testCase.id);
    if (cached) {
      log.info('Using cached plan', { testCaseId: testCase.id });
      return cached;
    }
  }

  const domContext = snapshot
    ? serializeSnapshotForPlanning(snapshot.url, snapshot.title, snapshot.domCompressed)
    : 'No DOM snapshot available.';

  const [knowledgeResults, rawGraph, flows] = await Promise.all([
    searchByText(
      `${testCase.title} ${testCase.description}`,
      (texts) => aiClient.embed(texts),
      3
    ).catch(() => []),
    loadGraph(),
    getAllFlows(),
  ]);
  const knowledgeContext = formatSearchResults(knowledgeResults);

  // Rewrite graph to target environment origin if different from exploration origin
  const graph = rewriteGraphToTargetOrigin(rawGraph, targetOrigin);

  const applicationContext = buildApplicationContext(graph, flows);

  const expectedSteps = [
    ...(testCase.setupSteps?.map((step) => `[Setup] ${step}`) ?? []),
    ...(testCase.steps ?? []),
  ];

  const testDescription = [
    `Title: ${testCase.title}`,
    `Description: ${testCase.description}`,
    testCase.executionPresetName ? `Execution preset: ${testCase.executionPresetName}` : '',
    testCase.personaLabel ? `Persona: ${testCase.personaLabel}` : '',
    testCase.requiresAuthenticatedSession
      ? 'Precondition: the user must already be authenticated before the main scenario starts.'
      : '',
    testCase.setupNotes ? `Setup notes: ${testCase.setupNotes}` : '',
    expectedSteps.length
      ? `\nExpected steps:\n${expectedSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
      : '',
    pageUrl ? `\nCurrent page URL: ${pageUrl}` : '',
  ].filter(Boolean).join('\n');

  const prompt = PROMPTS.testPlanning;
  let raw: string;

  try {
    // Merge the live accessibility tree with any externally injected accessibility context
  const mergedA11y = [a11yTree, extraContext?.accessibilityContext].filter(Boolean).join('\n\n').trim() || undefined;

  raw = await aiClient.chat(
      [
        { role: 'system', content: prompt.system },
        {
          role: 'user',
          content: prompt.user(
            testDescription,
            domContext,
            knowledgeContext,
            applicationContext,
            mergedA11y,
            extraContext?.apiContext
          ),
        },
      ],
      { temperature: 0.1, jsonMode: true }
    );
  } catch (err) {
    throw new Error(`Test planning failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const parsedSteps = parsePlanResponse(raw);
  const steps = groundNavigationSteps(parsedSteps, testCase, pageUrl, graph, targetOrigin);

  if (steps.length === 0) {
    throw new Error('AI returned an empty execution plan. Check the test description and DOM context.');
  }

  // Capture the starting URL from the first navigate step (or current page) for test isolation
  const startUrl = extractStartUrl(steps, pageUrl);
  if (startUrl && !testCase.startUrl) {
    await testCaseRepo.put({ ...testCase, startUrl });
  }

  const plan = await cachePlan(testCase.id, hash, { steps });

  log.info(`Planned test "${testCase.title}" with ${steps.length} steps (startUrl: ${startUrl})`);
  return plan;
}

function serializeSnapshotForPlanning(url: string, title: string, domCompressed: string): string {
  return `URL: ${url}
Title: ${title}

Interactive Elements:
${domCompressed}`;
}

function extractStartUrl(steps: ExecutionStep[], currentUrl: string): string | undefined {
  const firstNavigate = steps.find((s) => s.action === 'navigate' && s.value);
  return firstNavigate?.value ?? currentUrl ?? undefined;
}

function parsePlanResponse(raw: string): ExecutionStep[] {
  let json: unknown;

  try {
    const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
    json = JSON.parse(cleaned);
  } catch {
    log.warn('Failed to parse plan JSON');
    return [];
  }

  if (typeof json !== 'object' || json === null) return [];

  const obj = json as Record<string, unknown>;
  const steps = Array.isArray(obj['steps']) ? obj['steps'] : [];

  return steps
    .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
    .map((s, idx) => {
      const step: ExecutionStep = {
        order: Number(s['order'] ?? idx + 1),
        action: validateAction(s['action']),
        description: String(s['description'] ?? ''),
      };

      if (s['selector']) step.selector = String(s['selector']);
      if (s['value']) step.value = String(s['value']);
      if (s['timeout']) step.timeout = Number(s['timeout']);
      if (s['assertType']) step.assertType = validateAssertType(s['assertType']);
      if (s['assertExpected']) step.assertExpected = String(s['assertExpected']);
      if (s['key']) step.key = String(s['key']);
      if (s['attribute']) step.attribute = String(s['attribute']);
      if (s['targetSelector']) step.targetSelector = String(s['targetSelector']);

      return step;
    });
}

const VALID_ACTIONS: ActionType[] = [
  'click', 'double_click', 'type', 'navigate', 'wait', 'assert', 'scroll', 'hover',
  'select', 'check', 'uncheck', 'clear', 'press_key', 'drag_drop', 'upload_file', 'dismiss_dialog',
  'switch_tab',
];

function validateAction(raw: unknown): ActionType {
  if (typeof raw === 'string' && VALID_ACTIONS.includes(raw as ActionType)) {
    return raw as ActionType;
  }
  // Common aliases — map to correct types
  if (typeof raw === 'string') {
    const aliases: Record<string, ActionType> = {
      fill: 'type',
      input: 'type',
      enter: 'type',
      tap: 'click',
      press: 'click',
      goto: 'navigate',
      go: 'navigate',
      visit: 'navigate',
      verify: 'assert',
      expect: 'assert',
      key: 'press_key',
      keyboard: 'press_key',
      dropdown: 'select',
      choose: 'select',
      upload: 'upload_file',
      file: 'upload_file',
      dismiss: 'dismiss_dialog',
      alert: 'dismiss_dialog',
      confirm: 'dismiss_dialog',
      switch_tab: 'switch_tab',
      tab_switch: 'switch_tab',
      focus_tab: 'switch_tab',
    };
    const alias = aliases[raw.toLowerCase()];
    if (alias) return alias;
  }
  // Final fallback — default to click with a log warning
  log.warn(`Unknown action type "${String(raw)}" — defaulting to "click"`);
  return 'click';
}

const VALID_ASSERT_TYPES: AssertType[] = [
  'visible', 'not_visible', 'text', 'not_text', 'url', 'count', 'exact_count',
  'enabled', 'disabled', 'value', 'attribute', 'exists', 'not_exists',
];

function validateAssertType(raw: unknown): AssertType {
  if (typeof raw === 'string' && VALID_ASSERT_TYPES.includes(raw as AssertType)) {
    return raw as AssertType;
  }
  return 'visible';
}

/**
 * Return a shallow copy of the graph with all node and edge URLs rewritten to
 * the target origin. If the graph is undefined, or the target origin matches
 * the graph's existing origin, the original graph is returned unchanged.
 */
function rewriteGraphToTargetOrigin(
  graph: InteractionGraph | undefined,
  targetOrigin: string | undefined
): InteractionGraph | undefined {
  if (!graph || !targetOrigin) return graph;

  const graphOrigin = detectGraphOrigin(graph.nodes.map((n) => n.url));
  if (!graphOrigin || graphOrigin === targetOrigin) return graph;

  log.info(`Rewriting graph URLs for planner: ${graphOrigin} → ${targetOrigin}`);

  const rewriteUrl = (url: string) => {
    try { return rewriteOrigin(url, targetOrigin); } catch { return url; }
  };

  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({ ...node, url: rewriteUrl(node.url) })),
    edges: graph.edges.map((edge) => ({
      ...edge,
      from: rewriteUrl(edge.from),
      to: rewriteUrl(edge.to),
    })),
  };
}

function buildApplicationContext(
  graph: Awaited<ReturnType<typeof loadGraph>>,
  flows: Awaited<ReturnType<typeof getAllFlows>>
): string {
  const pageList = graph?.nodes.length
    ? graph.nodes
        .map((node) => `- ${node.title || 'Untitled'}: ${node.url}`)
        .join('\n')
    : 'No explored pages available.';

  const formFields = graph ? extractAllFormFields(graph) : 'No form fields captured.';
  const navigationMap = graph ? serializeNavigationMap(graph) : 'No navigation paths discovered.';
  const flowContext = serializeFlowsForAI(flows);

  return [
    'Known Pages:',
    pageList,
    '',
    'Navigation Map (click paths between pages):',
    navigationMap,
    '',
    'Known Form Fields:',
    formFields,
    '',
    'Learned Flows:',
    flowContext,
  ].join('\n');
}

function groundNavigationSteps(
  steps: ExecutionStep[],
  testCase: TestCase,
  currentPageUrl: string,
  graph: InteractionGraph | undefined,
  targetOrigin?: string
): ExecutionStep[] {
  if (!graph || graph.nodes.length === 0) {
    return steps;
  }

  const grounded: ExecutionStep[] = [];

  for (const step of steps) {
    if (step.action !== 'navigate') {
      grounded.push(step);
      continue;
    }

    grounded.push(...groundNavigateStep(step, testCase, currentPageUrl, graph, targetOrigin));
  }

  return grounded.map((step, index) => ({ ...step, order: index + 1 }));
}

function groundNavigateStep(
  step: ExecutionStep,
  testCase: TestCase,
  currentPageUrl: string,
  graph: InteractionGraph,
  targetOrigin?: string
): ExecutionStep[] {
  const trustedUrl = resolveTrustedNavigateUrl(step.value, currentPageUrl, testCase.startUrl, graph, targetOrigin);
  if (trustedUrl) {
    return [{ ...step, value: trustedUrl }];
  }

  const targetNode = inferTargetPageNode(step, testCase, graph);
  if (!targetNode) {
    log.warn('Planner returned an ungrounded navigate step with no matching known page', {
      description: step.description,
      value: step.value,
    });
    return [{ ...step, value: testCase.startUrl || currentPageUrl }];
  }

  const sourceNode = findBestSourceNode(currentPageUrl, testCase.startUrl, graph);
  const path = sourceNode ? findNavigationPath(sourceNode.url, targetNode.url, graph) : null;

  if (path && path.length > 0) {
    log.info('Rewriting invented navigate step to explored click path', {
      from: sourceNode?.url,
      to: targetNode.url,
      hops: path.length,
    });
    return path.map((edge, index) => ({
      order: step.order + index,
      action: 'click' as ActionType,
      selector: edge.selector,
      description: buildGroundedClickDescription(edge, graph),
    }));
  }

  log.info('Rewriting invented navigate step to known explored page URL', {
    inferredTarget: targetNode.url,
    description: step.description,
    originalValue: step.value,
  });
  return [
    {
      ...step,
      value: targetNode.url,
      description: `Navigate to known page ${targetNode.title || targetNode.url}`,
    },
  ];
}

function resolveTrustedNavigateUrl(
  rawUrl: string | undefined,
  currentPageUrl: string,
  testStartUrl: string | undefined,
  graph: InteractionGraph,
  targetOrigin?: string
): string | null {
  if (!rawUrl) return null;

  const resolved = resolveUrl(rawUrl, currentPageUrl || testStartUrl);
  if (!resolved) return null;

  // If a targetOrigin is set, also trust the rewritten form of each graph node
  const baseUrls = [currentPageUrl, testStartUrl ?? '', ...graph.nodes.map((node) => node.url)];
  const trustedUrls = new Set<string>(baseUrls);
  if (targetOrigin) {
    for (const url of baseUrls) {
      try { trustedUrls.add(rewriteOrigin(url, targetOrigin)); } catch { /* skip */ }
    }
  }

  return trustedUrls.has(resolved) ? resolved : null;
}

function inferTargetPageNode(
  step: ExecutionStep,
  testCase: TestCase,
  graph: InteractionGraph
): PageNode | null {
  const directHint = [step.value, step.description]
    .filter(Boolean)
    .join(' ')
    .trim();
  const broadHint = [
    directHint,
    testCase.title,
    testCase.description,
    ...(testCase.steps ?? []),
    ...(testCase.setupSteps ?? []),
  ]
    .filter(Boolean)
    .join(' ');

  const candidates = graph.nodes
    .map((node) => ({
      node,
      score: scorePageNode(node, directHint) * 2 + scorePageNode(node, broadHint),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].node;
  if (candidates[0].score >= candidates[1].score + 3) return candidates[0].node;

  return candidates[0].score >= 4 ? candidates[0].node : null;
}

function scorePageNode(node: PageNode, hint: string): number {
  const normalizedHint = tokenize(hint);
  if (normalizedHint.length === 0) return 0;

  const pageTitle = tokenize(node.title);
  const pageUrl = tokenize(node.url.replace(/https?:\/\//, '').replace(/[/?#._-]+/g, ' '));

  let score = 0;
  for (const token of normalizedHint) {
    if (pageTitle.includes(token)) score += 3;
    else if (pageUrl.includes(token)) score += 2;
  }

  const titleText = pageTitle.join(' ');
  const urlText = pageUrl.join(' ');
  const phrase = normalizedHint.join(' ');
  if (titleText.includes(phrase)) score += 4;
  if (urlText.includes(phrase)) score += 3;

  return score;
}

function findBestSourceNode(
  currentPageUrl: string,
  testStartUrl: string | undefined,
  graph: InteractionGraph
): PageNode | null {
  if (currentPageUrl) {
    const current = graph.nodes.find((node) => node.url === currentPageUrl);
    if (current) return current;
  }

  if (testStartUrl) {
    const start = graph.nodes.find((node) => node.url === testStartUrl);
    if (start) return start;
  }

  return null;
}

function findNavigationPath(
  fromUrl: string,
  toUrl: string,
  graph: InteractionGraph
): PageEdge[] | null {
  if (fromUrl === toUrl) return [];

  const queue: Array<{ url: string; path: PageEdge[] }> = [{ url: fromUrl, path: [] }];
  const visited = new Set<string>([fromUrl]);

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;

    const outgoing = graph.edges.filter((edge) => edge.from === current.url);
    for (const edge of outgoing) {
      if (visited.has(edge.to)) continue;
      const nextPath = [...current.path, edge];
      if (edge.to === toUrl) {
        return nextPath;
      }
      visited.add(edge.to);
      queue.push({ url: edge.to, path: nextPath });
    }
  }

  return null;
}

function buildGroundedClickDescription(edge: PageEdge, graph: InteractionGraph): string {
  const toNode = graph.nodes.find((node) => node.url === edge.to);
  return `Click ${edge.label} to open ${toNode?.title || edge.to}`;
}

function resolveUrl(rawUrl: string, baseUrl?: string): string | null {
  try {
    return new URL(rawUrl, baseUrl).toString();
  } catch {
    return null;
  }
}

function tokenize(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !COMMON_TOKENS.has(token));
}

const COMMON_TOKENS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'that',
  'this',
  'into',
  'then',
  'page',
  'open',
  'navigate',
  'click',
  'view',
  'user',
  'verify',
  'tab',
]);
