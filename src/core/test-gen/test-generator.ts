import type { AIClientInterface } from '../ai/ai-client';
import type { TestCase, Flow, TestPersonalityId, PageNode, FormField } from '../../storage/schemas';
import { PROMPTS } from '../ai/prompt-templates';
import { searchByText, formatSearchResults } from '../knowledge/vector-search';
import { serializeFlowForAI, getAllFlows } from '../flow/flow-store';
import { loadGraph, extractAllFormFields } from '../explorer/interaction-graph';
import { testCaseDB } from '../../storage/indexed-db';
import { generateId } from '../../utils/hash';
import { createLogger } from '../../utils/logger';
import { applyExecutionPresetToDraft } from './execution-preset';
import { deriveConstraintTests, saveConstraintTests, serializeFieldConstraints } from './constraint-test-generator';
import { getPersonality, createCustomPersonality, applyPersonalityToPrompt } from './test-personality';
import type { TestPersonality } from './test-personality';
import { estimateTokens } from '../knowledge/chunker';

const log = createLogger('test-generator');

export interface TestGenOptions {
  /** Test personality ID — controls AI tone, temperature, and emphasis. Default: 'balanced'. */
  personalityId?: TestPersonalityId;
  /** Free-text personality description when personalityId is 'custom'. */
  customPersonalityPrompt?: string;
}

export async function generateTestsForFlow(
  flow: Flow,
  aiClient: AIClientInterface,
  options: TestGenOptions = {}
): Promise<TestCase[]> {
  // Resolve personality — controls prompt tone and AI temperature
  const personality: TestPersonality = options.personalityId === 'custom' && options.customPersonalityPrompt
    ? createCustomPersonality(options.customPersonalityPrompt)
    : getPersonality(options.personalityId ?? 'balanced');
  log.info(`Using test personality: ${personality.name} (temp=${personality.temperature}, max=${personality.maxTestsPerFlow})`);

  const flowText = serializeFlowForAI(flow);

  const [knowledgeResults, graph] = await Promise.all([
    searchByText(
      `${flow.name} ${flow.description}`,
      (texts) => aiClient.embed(texts),
      5,
      { useAIReranker: true, aiClient }
    ),
    loadGraph(),
  ]);
  const context = formatSearchResults(knowledgeResults);

  // Score every page node for relevance to this flow, then pack the highest-
  // scoring nodes' form fields into the token budget. Multi-signal scoring
  // beats the old "title keyword OR exact URL" heuristic, which routinely
  // missed pages when the flow name didn't match the page title.
  const rankedNodes = graph ? rankNodesForFlow(flow, graph.nodes) : [];
  const MAX_FORM_FIELDS_TOKENS = 15_000;
  let formFieldsContext: string;
  const rawFormFields: FormField[] = [];

  if (rankedNodes.length === 0) {
    formFieldsContext = graph ? extractAllFormFields(graph) || 'No form fields captured.' : 'No form fields captured.';
  } else {
    // Pack top-ranked nodes' fields into the token budget. Stop adding once
    // we'd exceed MAX_FORM_FIELDS_TOKENS so the most-relevant pages survive
    // the cap instead of being truncated off the end.
    const includedRanked: typeof rankedNodes = [];
    let runningSerialized = '';
    for (const ranked of rankedNodes) {
      const fields = ranked.node.formFields ?? [];
      if (fields.length === 0) continue;
      const trial = serializeFieldConstraints([...rawFormFields, ...fields]);
      if (estimateTokens(trial) > MAX_FORM_FIELDS_TOKENS && includedRanked.length > 0) break;
      includedRanked.push(ranked);
      rawFormFields.push(...fields);
      runningSerialized = trial;
    }
    formFieldsContext = runningSerialized || 'No form fields captured.';

    if (includedRanked.length > 0) {
      log.info(
        `Test gen relevance: included ${includedRanked.length}/${rankedNodes.length} pages for flow "${flow.name}" — top: ${includedRanked
          .slice(0, 3)
          .map((r) => `"${r.node.title || r.node.url}" (score=${r.score}, ${r.matchedSignals.join('+')})`)
          .join(', ')}`
      );
    }
  }

  // Hard safety net — should never trigger thanks to the budget-aware packing
  // above, but keep it so a single huge page can't slip through.
  if (estimateTokens(formFieldsContext) > MAX_FORM_FIELDS_TOKENS) {
    const maxChars = MAX_FORM_FIELDS_TOKENS * 4;
    const cutPoint = formFieldsContext.lastIndexOf('\n', maxChars);
    formFieldsContext = formFieldsContext.slice(0, cutPoint > 0 ? cutPoint : maxChars) + '\n[...truncated to fit token budget]';
    log.warn(`Truncated form fields context after packing — single page exceeded budget`);
  }

  // Cross-flow dependency hints — detect if this flow has prerequisites
  const dependencyHints = await detectFlowDependencies(flow).catch(() => [] as string[]);

  const prompt = PROMPTS.testGeneration;
  const systemPrompt = applyPersonalityToPrompt(prompt.system, personality);
  let raw: string;

  try {
    raw = await aiClient.chat(
      [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: prompt.user(
            flowText,
            context,
            formFieldsContext,
            dependencyHints.length > 0 ? `\n\n## Cross-Flow Dependencies\n${dependencyHints.join('\n')}` : ''
          ),
        },
      ],
      // Generation emits multiple full test cases (steps + data) as JSON — give
      // it a large budget so reasoning models don't exhaust it before output.
      { temperature: personality.temperature, jsonMode: true, maxTokens: 8192 }
    );
  } catch (err) {
    throw new Error(`Test generation failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const parsed = parseTestsResponse(raw);
  const saved: TestCase[] = [];

  // Fetch existing tests for this flow to prevent duplicate generation.
  // Dedup by normalized title — if a test with the same title already exists,
  // skip it instead of creating a second copy.
  const existingTests = await testCaseDB.getByFlowId(flow.flowId);
  const existingTitles = new Set(
    existingTests.map((t) => t.title.toLowerCase().replace(/[^a-z0-9]/g, ''))
  );

  for (const t of parsed) {
    const normalizedTitle = t.title.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (existingTitles.has(normalizedTitle)) {
      log.debug(`Skipping duplicate test case: "${t.title}" (already exists for flow "${flow.name}")`);
      continue;
    }
    existingTitles.add(normalizedTitle);

    const testCase: TestCase = {
      id: generateId(),
      title: t.title,
      description: t.description,
      type: t.type,
      sourceFlowId: flow.flowId,
      source: 'generated',
      steps: t.steps,
      startUrl: flow.startUrl,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    await testCaseDB.put(testCase);
    saved.push(testCase);
  }

  // Generate deterministic constraint-based boundary tests from form field metadata
  if (rawFormFields.length > 0) {
    // Collect all observed form outcomes to ground assertions in real selectors
    const allFormOutcomes = graph?.nodes.flatMap((n) => n.formOutcomes ?? []) ?? [];
    const constraintSpecs = deriveConstraintTests(rawFormFields, flow.name, allFormOutcomes);
    const constraintTests = await saveConstraintTests(
      constraintSpecs.slice(0, 25), // cap at 25 per flow
      flow.flowId,
      flow.startUrl
    );
    saved.push(...constraintTests);
    log.info(`Generated ${constraintTests.length} constraint-based tests for flow "${flow.name}"`);
  }

  log.info(`Generated ${saved.length} total tests (${parsed.length} AI + ${saved.length - parsed.length} constraint) for flow "${flow.name}"`);
  return saved;
}

/**
 * Detect prerequisite flows for a given flow using multi-strategy analysis:
 * 1. URL overlap: flows that navigate to/from the same pages
 * 2. Resource naming: "Edit X" depends on "Create X"
 * 3. Step target overlap: flows that reference the same selectors/fields
 *
 * Also generates data passing hints (capture_value/use_captured) for downstream.
 */
export async function detectFlowDependencies(flow: Flow): Promise<string[]> {
  const allFlows = await getAllFlows();
  if (allFlows.length <= 1) return [];

  const hints: string[] = [];
  const flowNameLower = flow.name.toLowerCase();

  // ── Strategy 1: Resource naming pattern ───────────────────────────────
  // "Edit User" depends on "Create User", "Delete Order" depends on "Create Order"
  const CONSUMER_VERBS = /\b(edit|update|delete|remove|view|detail|open|read|modify|assign|approve|reject)\b/i;
  const PRODUCER_VERBS = /\b(create|add|new|register|submit|upload|import)\b/i;

  const isConsumer = CONSUMER_VERBS.test(flowNameLower);

  if (isConsumer) {
    // Extract resource name by removing the verb
    const resourceMatch = flowNameLower
      .replace(CONSUMER_VERBS, '')
      .replace(/^\s+|\s+$/g, '')
      .replace(/\s+/g, ' ');

    if (resourceMatch.length > 1) {
      // Find matching producer flows — fuzzy match on resource name
      const producers = allFlows.filter((f) => {
        if (f.flowId === flow.flowId) return false;
        const otherName = f.name.toLowerCase();
        if (!PRODUCER_VERBS.test(otherName)) return false;
        const otherResource = otherName.replace(PRODUCER_VERBS, '').replace(/^\s+|\s+$/g, '').replace(/\s+/g, ' ');
        // Fuzzy match: either resource contains the other, or they share >50% words
        return otherResource.includes(resourceMatch) ||
               resourceMatch.includes(otherResource) ||
               wordOverlap(resourceMatch, otherResource) > 0.5;
      });

      for (const producer of producers) {
        hints.push(`Prerequisite: "${producer.name}" must run before this test to ensure a ${resourceMatch} exists.`);
        hints.push(`Data passing: After "${producer.name}", capture the created resource ID/name using capture_value, then reference it in this test using {{captured_${resourceMatch.replace(/\s+/g, '_')}_id}}.`);
      }
    }
  }

  // ── Strategy 2: URL chain analysis ────────────────────────────────────
  // If this flow's start URL matches another flow's end URL (or vice versa),
  // there's likely a dependency
  if (flow.startUrl) {
    const targetUrlNorm = flow.startUrl.replace(/\/+$/, '');
    for (const other of allFlows) {
      if (other.flowId === flow.flowId) continue;
      // Check if another flow navigates TO this flow's start URL
      const otherHasNav = other.steps.some((s) =>
        s.action === 'navigate' && s.target?.replace(/\/+$/, '') === targetUrlNorm
      );
      if (otherHasNav && !hints.some((h) => h.includes(other.name))) {
        hints.push(`Related flow: "${other.name}" navigates to this flow's start page. Consider ordering it before this test.`);
      }
    }
  }

  // ── Strategy 3: Shared selector overlap ───────────────────────────────
  // Flows that reference the same form fields likely operate on the same entity
  const thisSelectors = new Set(flow.steps.map((s) => s.selector).filter(Boolean));
  if (thisSelectors.size > 0) {
    for (const other of allFlows) {
      if (other.flowId === flow.flowId) continue;
      if (hints.some((h) => h.includes(other.name))) continue; // Already found
      const otherSelectors = new Set(other.steps.map((s) => s.selector).filter(Boolean));
      const sharedCount = [...thisSelectors].filter((s) => otherSelectors.has(s!)).length;
      if (sharedCount >= 3) {
        hints.push(`Related flow: "${other.name}" shares ${sharedCount} selectors with this flow — they likely operate on the same entity.`);
      }
    }
  }

  return hints;
}

function wordOverlap(a: string, b: string): number {
  const setA = new Set(a.split(/\s+/).filter((w) => w.length > 2));
  const setB = new Set(b.split(/\s+/).filter((w) => w.length > 2));
  if (setA.size === 0 || setB.size === 0) return 0;
  let common = 0;
  for (const w of setA) if (setB.has(w)) common++;
  return common / Math.max(setA.size, setB.size);
}

export async function createUserTestCase(
  title: string,
  description: string,
  options: {
    type?: TestCase['type'];
    steps?: string[];
    startUrl?: string;
    executionPresetId?: string;
  } = {}
): Promise<TestCase> {
  const draft = await applyExecutionPresetToDraft({
    id: generateId(),
    title,
    description,
    type: options.type ?? 'positive',
    source: 'user',
    steps: options.steps && options.steps.length > 0 ? options.steps : undefined,
    startUrl: options.startUrl || undefined,
  }, options.executionPresetId);

  const testCase: TestCase = {
    ...draft,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  await testCaseDB.put(testCase);
  return testCase;
}

function parseTestsResponse(
  raw: string
): Array<{ title: string; description: string; type: TestCase['type']; steps?: string[] }> {
  let json: unknown;

  try {
    const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
    json = JSON.parse(cleaned);
  } catch {
    log.warn('Failed to parse tests JSON');
    return [];
  }

  if (typeof json !== 'object' || json === null) return [];

  const obj = json as Record<string, unknown>;
  const tests = Array.isArray(obj['tests']) ? obj['tests'] : [];

  return tests
    .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
    .map((t) => ({
      title: String(t['title'] ?? 'Unnamed Test'),
      description: String(t['description'] ?? ''),
      type: validateTestType(t['type']),
      steps: Array.isArray(t['steps']) ? t['steps'].map(String) : undefined,
    }));
}

interface RankedNode {
  node: PageNode;
  score: number;
  matchedSignals: string[];
}

/**
 * Rank graph nodes by relevance to a flow using multi-signal scoring.
 *
 * Signals (additive):
 *  - exact-url    +100   node.url matches flow.startUrl or any navigate step value
 *  - path-overlap +N×8   number of path segments shared with flow URLs
 *  - selector-hit +20    a flow step's selector matches a captured form field's selector
 *  - target-token +5     a flow step's target shares ≥1 word with the page title or URL
 *  - title-token  +3     page title contains a token from the flow name (≥3 chars)
 *  - url-token    +2     page URL contains a token from the flow name (≥3 chars)
 *
 * Returns nodes with score > 0, sorted descending. Caller then packs into a
 * token budget so the highest-scoring pages survive the cap.
 */
export function rankNodesForFlow(flow: Flow, nodes: PageNode[]): RankedNode[] {
  const explicitUrls = new Set(
    [
      flow.startUrl,
      ...flow.steps.filter((s) => s.action === 'navigate').map((s) => s.value),
      ...flow.steps.filter((s) => s.action === 'navigate').map((s) => s.target),
    ].filter((u): u is string => Boolean(u))
  );

  const explicitPathSegs = new Set<string>();
  for (const url of explicitUrls) {
    for (const seg of pathSegmentsOf(url)) explicitPathSegs.add(seg);
  }

  const flowSelectors = new Set(
    flow.steps.map((s) => s.selector).filter((s): s is string => Boolean(s))
  );

  const flowNameTokens = tokenize(flow.name);
  const flowTargetTokens = new Set<string>();
  for (const step of flow.steps) {
    for (const tok of tokenize([step.target, step.description, step.value].filter(Boolean).join(' '))) {
      flowTargetTokens.add(tok);
    }
  }

  const ranked: RankedNode[] = [];
  for (const node of nodes) {
    let score = 0;
    const signals: string[] = [];

    if (explicitUrls.has(node.url)) {
      score += 100;
      signals.push('exact-url');
    }

    const nodeSegs = pathSegmentsOf(node.url);
    let pathOverlap = 0;
    for (const seg of nodeSegs) if (explicitPathSegs.has(seg)) pathOverlap++;
    if (pathOverlap > 0) {
      score += pathOverlap * 8;
      signals.push(`path-overlap×${pathOverlap}`);
    }

    if (flowSelectors.size > 0 && node.formFields && node.formFields.length > 0) {
      let selectorHits = 0;
      for (const field of node.formFields) {
        if (field.selector && flowSelectors.has(field.selector)) selectorHits++;
      }
      if (selectorHits > 0) {
        score += selectorHits * 20;
        signals.push(`selector-hit×${selectorHits}`);
      }
    }

    const titleTokens = tokenize(node.title || '');
    const urlTokens = tokenize(node.url);

    let titleHits = 0;
    for (const tok of flowNameTokens) if (titleTokens.has(tok)) titleHits++;
    if (titleHits > 0) {
      score += titleHits * 3;
      signals.push(`title-token×${titleHits}`);
    }

    let urlHits = 0;
    for (const tok of flowNameTokens) if (urlTokens.has(tok)) urlHits++;
    if (urlHits > 0) {
      score += urlHits * 2;
      signals.push(`url-token×${urlHits}`);
    }

    if (flowTargetTokens.size > 0) {
      let targetHits = 0;
      for (const tok of flowTargetTokens) {
        if (titleTokens.has(tok) || urlTokens.has(tok)) {
          targetHits++;
          if (targetHits >= 3) break; // diminishing returns
        }
      }
      if (targetHits > 0) {
        score += targetHits * 5;
        signals.push(`target-token×${targetHits}`);
      }
    }

    if (score > 0) ranked.push({ node, score, matchedSignals: signals });
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

function pathSegmentsOf(url: string): string[] {
  try {
    return new URL(url).pathname
      .split('/')
      .filter(Boolean)
      .map((s) => s.toLowerCase());
  } catch {
    return [];
  }
}

function tokenize(input: string): Set<string> {
  return new Set(
    input
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .filter((t) => t.length >= 3)
  );
}

function validateTestType(raw: unknown): TestCase['type'] {
  const valid: TestCase['type'][] = ['positive', 'negative', 'edge'];
  if (typeof raw === 'string' && valid.includes(raw as TestCase['type'])) {
    return raw as TestCase['type'];
  }
  return 'positive';
}
