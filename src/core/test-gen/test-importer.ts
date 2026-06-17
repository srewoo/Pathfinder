import type { AIClientInterface } from '../ai/ai-client';
import type { TestCase } from '../../storage/schemas';
import { PROMPTS } from '../ai/prompt-templates';
import { searchByText, formatSearchResults } from '../knowledge/vector-search';
import { loadGraph } from '../explorer/interaction-graph';
import { getAllFlows } from '../flow/flow-store';
import { testCaseDB, planDB, vectorDB } from '../../storage/indexed-db';
import { generateId } from '../../utils/hash';
import { createLogger } from '../../utils/logger';
import { estimateTokens } from '../knowledge/chunker';
import { applyExecutionPresetToDraft, formatExecutionPresetContext, resolveExecutionPresetSnapshot } from './execution-preset';

const log = createLogger('test-importer');

/** Lightweight graph shape for retrieval and fallback step generation. */
type InteractionGraphLike = {
  nodes: Array<{
    url: string;
    title: string;
    formFields?: Array<{
      selector: string; label?: string; name?: string; type: string; required: boolean;
      options?: string[]; minLength?: number; maxLength?: number; min?: string; max?: string; pattern?: string;
    }>;
    formOutcomes?: Array<{ result: string; resultMessage?: string; submitSelector: string }>;
    actions?: Array<{ selector: string; label: string; kind: string }>;
  }>;
  edges?: Array<{ from: string; to: string; label: string; selector: string }>;
} | undefined;

// ── Public types ─────────────────────────────────────────────────────────────

export interface ImportedTestCase {
  title: string;
  type?: 'positive' | 'negative' | 'edge';
  startUrl?: string;
  context?: string;
  steps?: string[];
  executionPresetId?: string;
}

export interface ImportedTestsFile {
  version: string;
  tests: ImportedTestCase[];
}

export interface ImportProgress {
  current: number;
  total: number;
  title: string;
  phase: 'expanding' | 'saving';
}

export interface ExpandedImportedTestCase {
  title: string;
  description: string;
  type: TestCase['type'];
  startUrl?: string;
  steps: string[];
}

// ── Main entry point ─────────────────────────────────────────────────────────

export async function importAndExpandTests(
  importedTests: ImportedTestCase[],
  aiClient: AIClientInterface,
  onProgress?: (progress: ImportProgress) => void
): Promise<TestCase[]> {
  const expandedTests = await expandImportedTests(importedTests, aiClient, onProgress);
  const saved: TestCase[] = [];

  for (let i = 0; i < importedTests.length; i++) {
    const imported = importedTests[i];
    const expanded = expandedTests[i];

    onProgress?.({ current: i + 1, total: importedTests.length, title: imported.title, phase: 'saving' });

    const draft = await applyExecutionPresetToDraft({
      id: generateId(),
      title: expanded.title,
      description: expanded.description,
      type: expanded.type,
      source: 'user',
      steps: expanded.steps.length > 0 ? expanded.steps : undefined,
      startUrl: imported.startUrl || expanded.startUrl || undefined,
    }, imported.executionPresetId);

    const testCase: TestCase = {
      ...draft,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    await testCaseDB.put(testCase);
    saved.push(testCase);
    log.info(`Imported and expanded: "${testCase.title}"`);
  }

  return saved;
}

export async function expandImportedTests(
  importedTests: ImportedTestCase[],
  aiClient: AIClientInterface,
  onProgress?: (progress: ImportProgress) => void
): Promise<ExpandedImportedTestCase[]> {
  // Load raw data once — each test case will query for relevant subsets
  const [graph, flows] = await Promise.all([loadGraph(), getAllFlows()]);
  const expanded: ExpandedImportedTestCase[] = [];

  for (let i = 0; i < importedTests.length; i++) {
    const imported = importedTests[i];

    onProgress?.({ current: i + 1, total: importedTests.length, title: imported.title, phase: 'expanding' });

    try {
      const withUrl = {
        ...imported,
        startUrl: imported.startUrl || inferStartUrlFromTitle(imported.title, graph),
      };
      expanded.push(await expandTestCase(withUrl, aiClient, graph ?? undefined, flows));
    } catch (err) {
      log.warn(`Expansion failed for "${imported.title}", using graph-aware fallback`, err);
      expanded.push(makeSparseExpansion(imported, graph ?? undefined));
    }
  }

  return expanded;
}

/**
 * Expands a single sparse user-authored test case using all available context
 * (RAG knowledge, application map, learned flows) and saves it to IndexedDB.
 * Called from the service worker in response to EXPAND_TEST_CASE messages.
 */
export async function expandAndSaveTestCase(
  input: { title: string; description: string; type: ImportedTestCase['type']; steps?: string[]; startUrl?: string; executionPresetId?: string },
  aiClient: AIClientInterface
): Promise<TestCase> {
  const imported: ImportedTestCase = {
    title: input.title,
    type: input.type,
    context: input.description !== input.title ? input.description : undefined,
    steps: input.steps,
    startUrl: input.startUrl,
    executionPresetId: input.executionPresetId,
  };

  const [graph, flows] = await Promise.all([loadGraph(), getAllFlows()]);
  const importedWithUrl = {
    ...imported,
    startUrl: imported.startUrl || input.startUrl || inferStartUrlFromTitle(imported.title, graph),
  };
  const expanded = await expandTestCase(importedWithUrl, aiClient, graph ?? undefined, flows);

  const draft = await applyExecutionPresetToDraft({
    id: generateId(),
    title: expanded.title,
    description: expanded.description,
    type: expanded.type,
    source: 'user',
    steps: expanded.steps.length > 0 ? expanded.steps : undefined,
    startUrl: input.startUrl || expanded.startUrl || undefined,
  }, input.executionPresetId);

  const testCase: TestCase = {
    ...draft,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  await testCaseDB.put(testCase);
  log.info(`Expanded and saved: "${testCase.title}"`);
  return testCase;
}

/**
 * Regenerates the natural language steps for an existing TestCase by injecting
 * extra context provided by the user and re-prompting the AI.
 */
export async function regenerateTestCaseSteps(
  testCaseId: string,
  additionalContext: string,
  aiClient: AIClientInterface
): Promise<TestCase> {
  const existing = await testCaseDB.get(testCaseId);
  if (!existing) throw new Error('Test case not found');

  const combinedDescription = existing.description
    ? `${existing.description}\n\nAdditional Context: ${additionalContext}`
    : `Additional Context: ${additionalContext}`;

  // Save feedback as persistent global knowledge rule
  const vectorId = generateId();
  try {
    const feedbackText = `User Correction / Testing Rule for feature "${existing.title}": ${additionalContext}`;
    const [embedding] = await aiClient.embed([feedbackText]);
    
    await vectorDB.put({
      id: vectorId,
      url: `feedback://testcase/${testCaseId}`,
      content: feedbackText,
      // Our UI uses Float32Array to halve storage cost, so we cast it exactly like in embedder.ts
      embedding: new Float32Array(embedding) as unknown as number[],
      metadata: {
        title: 'User Correction',
        section: existing.title,
        crawledAt: new Date().toISOString(),
        chunkIndex: 0,
        totalChunks: 1,
      }
    });
    log.info(`Saved user feedback to vector DB: ${vectorId}`);
  } catch (err) {
    log.warn('Failed to embed user feedback globally', err);
  }

  const imported: ImportedTestCase = {
    title: existing.title,
    type: existing.type,
    context: combinedDescription,
    startUrl: existing.startUrl,
    executionPresetId: existing.executionPresetId,
  };

  const [graph, flows] = await Promise.all([loadGraph(), getAllFlows()]);
  const importedWithUrl = {
    ...imported,
    startUrl: imported.startUrl || inferStartUrlFromTitle(imported.title, graph),
  };

  const expanded = await expandTestCase(importedWithUrl, aiClient, graph ?? undefined, flows);

  const updatedTestCase: TestCase = {
    ...existing,
    description: expanded.description,
    steps: expanded.steps.length > 0 ? expanded.steps : undefined,
    startUrl: expanded.startUrl || existing.startUrl,
    status: 'pending',
  };

  await testCaseDB.put(updatedTestCase);

  // Clear any existing cached execution plans for this test case
  const plans = await planDB.getAll();
  for (const p of plans) {
    if (p.testCaseId === testCaseId) {
      await planDB.delete(p.id);
    }
  }

  log.info(`Regenerated steps for: "${updatedTestCase.title}"`);
  return updatedTestCase;
}

// ── Validation ────────────────────────────────────────────────────────────────

export function validateImportFile(raw: unknown): { valid: true; file: ImportedTestsFile } | { valid: false; error: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { valid: false, error: 'JSON must be an object.' };
  }

  const obj = raw as Record<string, unknown>;

  if (!Array.isArray(obj['tests'])) {
    return { valid: false, error: 'Missing "tests" array. See the format sample.' };
  }

  const tests = obj['tests'] as unknown[];
  if (tests.length === 0) {
    return { valid: false, error: '"tests" array is empty.' };
  }
  if (tests.length > 50) {
    return { valid: false, error: 'Maximum 50 test cases per import.' };
  }

  for (let i = 0; i < tests.length; i++) {
    const t = tests[i];
    if (typeof t !== 'object' || t === null) {
      return { valid: false, error: `tests[${i}] must be an object.` };
    }
    const tc = t as Record<string, unknown>;
    if (!tc['title'] || typeof tc['title'] !== 'string') {
      return { valid: false, error: `tests[${i}] is missing a "title" string.` };
    }
  }

  return {
    valid: true,
    file: {
      version: String(obj['version'] ?? '1'),
      tests: tests.map((t) => {
        const tc = t as Record<string, unknown>;
        return {
          title: String(tc['title']),
          type: validateType(tc['type']),
          startUrl: tc['startUrl'] ? String(tc['startUrl']) : undefined,
          context: tc['context'] ? String(tc['context']) : undefined,
          steps: Array.isArray(tc['steps']) ? tc['steps'].map(String) : undefined,
          executionPresetId: tc['executionPresetId'] ? String(tc['executionPresetId']) : undefined,
        };
      }),
    },
  };
}

// ── Internal: expand one test case ───────────────────────────────────────────

async function expandTestCase(
  imported: ImportedTestCase,
  aiClient: AIClientInterface,
  graph?: InteractionGraphLike,
  flows?: import('../../storage/schemas').Flow[]
): Promise<ExpandedImportedTestCase> {
  const preset = await resolveExecutionPresetSnapshot(imported.executionPresetId);
  const presetContext = preset.executionPresetId
    ? formatExecutionPresetContext({
        name: preset.executionPresetName ?? 'Preset',
        personaLabel: preset.personaLabel,
        requiresAuthenticatedSession: preset.requiresAuthenticatedSession ?? false,
        setupSteps: preset.setupSteps,
        setupNotes: preset.setupNotes,
      })
    : '';

  const combinedContext = [presetContext, imported.context ?? ''].filter(Boolean).join('\n');
  const query = [imported.title, combinedContext, ...(imported.steps ?? []), ...(preset.setupSteps ?? [])].join(' ');

  // ── 1. RAG: Query knowledge base for relevant documentation ──────────
  const knowledgeResults = await searchByText(query, (texts) => aiClient.embed(texts), 3);
  const knowledgeContext = formatSearchResults(knowledgeResults);

  // ── 2. Query exploration graph: find relevant pages, not the whole graph ─
  const retrieved = retrieveRelevantContext(imported, graph, flows);

  log.info(`Expansion context for "${imported.title}": ${retrieved.pageCount} pages, ${retrieved.fieldCount} fields, ${retrieved.flowCount} flows, ~${estimateTokens(retrieved.graphContext + retrieved.formFieldsContext + retrieved.flowsContext + retrieved.navigationContext)} tokens`);

  const prompt = PROMPTS.testExpansion;
  const messages = [
    { role: 'system' as const, content: prompt.system },
    {
      role: 'user' as const,
      content: prompt.user(
        {
          ...imported,
          context: combinedContext || imported.context,
          startUrl: imported.startUrl || preset.startUrl,
          steps: imported.steps?.length ? [...(preset.setupSteps ?? []), ...imported.steps] : preset.setupSteps,
        },
        knowledgeContext,
        retrieved.graphContext,
        retrieved.flowsContext,
        retrieved.formFieldsContext,
        retrieved.navigationContext
      ),
    },
  ];

  const raw = await aiClient.chat(messages, { temperature: 0.2, jsonMode: true, maxTokens: 8192 });
  const result = parseExpansionResponse(raw, imported, graph);

  // If first attempt returned no steps, retry with a nudge for the AI to be more detailed
  if (result.steps.length === 0 || (result.steps.length <= 1 && result.steps[0]?.startsWith('Navigate'))) {
    log.info(`Expansion for "${imported.title}" returned sparse steps, retrying with explicit nudge`);
    try {
      const retryMessages = [
        ...messages,
        { role: 'assistant' as const, content: raw },
        { role: 'user' as const, content: 'The response has no detailed steps. Please generate at least 4-6 specific, actionable test steps with exact field names, values to type, buttons to click, and assertions to verify. Return JSON with a "steps" array of strings.' },
      ];
      const retryRaw = await aiClient.chat(retryMessages, { temperature: 0.3, jsonMode: true, maxTokens: 8192 });
      const retryResult = parseExpansionResponse(retryRaw, imported, graph);
      if (retryResult.steps.length > result.steps.length) {
        return retryResult;
      }
    } catch (retryErr) {
      log.debug('Expansion retry failed, using first attempt result', retryErr);
    }
  }

  return result;
}

function parseExpansionResponse(raw: string, fallback: ImportedTestCase, graph?: InteractionGraphLike): ExpandedImportedTestCase {
  try {
    const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
    let json = JSON.parse(cleaned) as Record<string, unknown>;

    // Handle wrapped responses: { "test": {...} } or { "testCase": {...} }
    if (!json['steps'] && !json['title']) {
      const inner = json['test'] ?? json['testCase'] ?? json['result'];
      if (inner && typeof inner === 'object') {
        json = inner as Record<string, unknown>;
      }
    }

    // Try multiple key names for steps — AI sometimes uses "testSteps", "test_steps", etc.
    let steps: string[] = [];
    const stepsRaw = json['steps'] ?? json['testSteps'] ?? json['test_steps'];
    if (Array.isArray(stepsRaw)) {
      steps = stepsRaw
        .map((s) => {
          if (typeof s === 'string') return s;
          if (typeof s === 'object' && s !== null) {
            // Handle { "step": "...", "description": "..." } format
            const obj = s as Record<string, unknown>;
            return String(obj['description'] ?? obj['step'] ?? obj['action'] ?? '');
          }
          return String(s);
        })
        .filter(Boolean);
    }

    // If AI returned no steps, that's a failed expansion — log and fall through to fallback
    if (steps.length === 0) {
      log.warn('AI expansion returned no steps — using sparse fallback', { title: fallback.title, rawLength: raw.length });
      return makeSparseExpansion(fallback, graph);
    }

    return {
      title: String(json['title'] ?? fallback.title),
      description: String(json['description'] ?? fallback.context ?? fallback.title),
      type: validateType(json['type']) ?? fallback.type ?? 'positive',
      startUrl: json['startUrl'] ? String(json['startUrl']) : fallback.startUrl,
      steps,
    };
  } catch (err) {
    log.warn('Failed to parse AI expansion response', { title: fallback.title, err: err instanceof Error ? err.message : String(err) });
    return makeSparseExpansion(fallback);
  }
}

// ── Retrieval-based context building ────────────────────────────────────────
// Instead of serializing the entire graph, query for relevant pages/flows/fields
// per test case — like RAG but for exploration data.

interface RetrievedContext {
  graphContext: string;
  formFieldsContext: string;
  navigationContext: string;
  flowsContext: string;
  pageCount: number;
  fieldCount: number;
  flowCount: number;
}

/**
 * Retrieve only the relevant exploration data for a specific test case.
 * Searches the graph for matching pages by keyword, URL, and form field labels.
 * Returns compact, focused context that fits within token budgets.
 */
function retrieveRelevantContext(
  imported: ImportedTestCase,
  graph: InteractionGraphLike,
  flows?: import('../../storage/schemas').Flow[]
): RetrievedContext {
  const empty: RetrievedContext = {
    graphContext: 'No application map available — run Exploration first.',
    formFieldsContext: 'No form fields captured.',
    navigationContext: 'No navigation paths discovered.',
    flowsContext: 'No learned workflows.',
    pageCount: 0, fieldCount: 0, flowCount: 0,
  };

  if (!graph || graph.nodes.length === 0) return empty;

  const titleLower = imported.title.toLowerCase();
  const keywords = titleLower.split(/[^a-z0-9]+/).filter((w) => w.length >= 3);

  // ── 1. Score and rank pages by relevance to this test ─────────────
  const scoredPages = graph.nodes.map((node) => {
    let score = 0;
    const nodeText = `${node.title} ${node.url}`.toLowerCase();

    // URL match (exact or startUrl)
    if (imported.startUrl && node.url === imported.startUrl) score += 20;

    // Keyword matches in title/URL
    for (const kw of keywords) {
      if (nodeText.includes(kw)) score += 3;
    }

    // Keyword matches in form field labels/names
    if (node.formFields) {
      for (const f of node.formFields) {
        const fieldText = `${f.label ?? ''} ${f.name ?? ''} ${f.type}`.toLowerCase();
        for (const kw of keywords) {
          if (fieldText.includes(kw)) score += 2;
        }
      }
      // Boost pages with form fields (more actionable)
      if (node.formFields.length > 0) score += 2;
    }

    // Boost pages with form outcomes (have observed behavior)
    if (node.formOutcomes && node.formOutcomes.length > 0) score += 3;

    return { node, score };
  });

  // Take top 5 most relevant pages (enough for context without overwhelming)
  const relevantPages = scoredPages
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((p) => p.node);

  if (relevantPages.length === 0) {
    // No relevant pages found — include a few pages with forms as fallback
    const pagesWithForms = graph.nodes.filter((n) => n.formFields && n.formFields.length > 0).slice(0, 3);
    if (pagesWithForms.length > 0) relevantPages.push(...pagesWithForms);
  }

  // ── 2. Build focused graph context from relevant pages ────────────
  const graphLines: string[] = ['## Relevant Application Pages'];
  for (const page of relevantPages) {
    graphLines.push(`\n### ${page.title || 'Untitled'} (${page.url})`);
    if (page.actions) {
      graphLines.push('Actions:');
      for (const a of page.actions.slice(0, 10)) {
        graphLines.push(`  - [${a.kind}] "${a.label}" (${a.selector})`);
      }
    }
  }

  // ── 3. Build focused form fields from relevant pages ──────────────
  const fieldLines: string[] = ['## Form Fields on Relevant Pages'];
  let fieldCount = 0;
  for (const page of relevantPages) {
    if (!page.formFields || page.formFields.length === 0) continue;
    fieldLines.push(`\n### ${page.title || page.url}`);
    for (const f of page.formFields) {
      const parts: string[] = [`- **${f.label || f.name || f.type}** (${f.selector}): type=${f.type}`];
      if (f.required) parts.push('**REQUIRED**');
      if (f.options?.length) parts.push(`options=[${f.options.slice(0, 10).join(', ')}]`);
      if (f.minLength != null) parts.push(`minLength=${f.minLength}`);
      if (f.maxLength != null) parts.push(`maxLength=${f.maxLength}`);
      if (f.pattern) parts.push(`pattern=${f.pattern}`);
      if (f.min != null) parts.push(`min=${f.min}`);
      if (f.max != null) parts.push(`max=${f.max}`);
      fieldLines.push(parts.join(', '));
      fieldCount++;
    }
    // Include observed form outcomes
    if (page.formOutcomes) {
      fieldLines.push('Observed submission outcomes:');
      for (const o of page.formOutcomes) {
        fieldLines.push(`  - ${o.result}${o.resultMessage ? `: "${o.resultMessage}"` : ''}${o.submitSelector ? ` (submit: ${o.submitSelector})` : ''}`);
      }
    }
  }

  // ── 4. Build navigation context: how to reach relevant pages ──────
  const navLines: string[] = ['## Navigation Paths'];
  if (graph.nodes.length > 0) {
    // Find edges leading TO relevant pages
    const relevantUrls = new Set(relevantPages.map((p) => p.url));
    if (graph.edges) {
      for (const edge of graph.edges) {
        if (relevantUrls.has(edge.to)) {
          navLines.push(`- From "${edge.from}" → click "${edge.label}" (${edge.selector}) → "${edge.to}"`);
        }
      }
    }
    if (navLines.length === 1) navLines.push('No navigation edges found to relevant pages. Navigate directly by URL.');
  }

  // ── 5. Find relevant flows by keyword match ───────────────────────
  const flowLines: string[] = ['## Relevant Learned Workflows'];
  let flowCount = 0;
  if (flows && flows.length > 0) {
    const scoredFlows = flows.map((flow) => {
      let score = 0;
      const flowText = `${flow.name} ${flow.description}`.toLowerCase();
      for (const kw of keywords) {
        if (flowText.includes(kw)) score += 3;
      }
      return { flow, score };
    });

    const relevantFlows = scoredFlows
      .filter((f) => f.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    for (const { flow } of relevantFlows) {
      flowLines.push(`\n### ${flow.name}`);
      flowLines.push(`${flow.description}`);
      if (flow.startUrl) flowLines.push(`Start URL: ${flow.startUrl}`);
      flowLines.push('Steps:');
      for (const step of flow.steps) {
        flowLines.push(`  ${step.order}. [${step.action}] ${step.description}${step.selector ? ` (${step.selector})` : ''}`);
      }
      flowCount++;
    }

    if (relevantFlows.length === 0) {
      flowLines.push('No workflows match this test case.');
    }
  }

  return {
    graphContext: graphLines.join('\n'),
    formFieldsContext: fieldLines.join('\n'),
    navigationContext: navLines.join('\n'),
    flowsContext: flowLines.join('\n'),
    pageCount: relevantPages.length,
    fieldCount,
    flowCount,
  };
}

function inferStartUrlFromTitle(
  title: string,
  graph: { nodes: Array<{ url: string; title: string; formFields?: Array<{ label?: string; name?: string }> }> } | undefined
): string | undefined {
  if (!graph || graph.nodes.length === 0) return undefined;

  const titleLower = title.toLowerCase();
  const keywords = titleLower.split(/[^a-z0-9]+/).filter((w) => w.length >= 3);

  let bestUrl: string | undefined;
  let bestScore = 0;

  for (const node of graph.nodes) {
    let score = 0;
    const nodeTitle = (node.title || '').toLowerCase();
    const nodeUrl = node.url.toLowerCase();

    for (const kw of keywords) {
      if (nodeTitle.includes(kw)) score += 3;
      if (nodeUrl.includes(kw)) score += 2;
      // Check if form fields on this page match the test intent
      if (node.formFields) {
        for (const field of node.formFields) {
          const fieldText = [field.label, field.name].filter(Boolean).join(' ').toLowerCase();
          if (fieldText.includes(kw)) score += 1;
        }
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestUrl = node.url;
    }
  }

  return bestScore >= 3 ? bestUrl : undefined;
}

function makeSparseExpansion(imported: ImportedTestCase, graph?: InteractionGraphLike): ExpandedImportedTestCase {
  // Generate meaningful fallback steps using graph data instead of returning empty
  const steps = imported.steps && imported.steps.length > 0
    ? imported.steps
    : generateFallbackSteps(imported, graph);

  return {
    title: imported.title,
    description: imported.context ?? imported.title,
    type: imported.type ?? 'positive',
    startUrl: imported.startUrl,
    steps,
  };
}

/**
 * Generate context-aware fallback steps from the test title + exploration graph.
 * When graph data is available, references actual form fields, buttons, and selectors.
 */
function generateFallbackSteps(imported: ImportedTestCase, graph?: InteractionGraphLike): string[] {
  const steps: string[] = [];
  const title = imported.title.toLowerCase();

  // Try to find the relevant page in the graph
  const targetPage = findTargetPage(imported.title, imported.startUrl, graph);

  // Step 1: Navigate
  if (imported.startUrl) {
    steps.push(`Navigate to ${imported.startUrl}`);
  } else if (targetPage) {
    steps.push(`Navigate to ${targetPage.url} ("${targetPage.title}")`);
  } else {
    steps.push('Navigate to the relevant page for this test');
  }

  // Step 2: Use real form fields from graph if available
  if (targetPage?.formFields && targetPage.formFields.length > 0) {
    // Find a submit/create button from page actions or form outcomes
    const submitAction = targetPage.actions?.find((a) =>
      a.kind === 'action' && /submit|save|create|add|send|confirm/i.test(a.label)
    );
    const submitSelector = submitAction?.selector
      ?? targetPage.formOutcomes?.[0]?.submitSelector;

    if (title.includes('create') || title.includes('add') || title.includes('new') || title.includes('submit')) {
      // Generate per-field steps from actual form metadata
      for (const field of targetPage.formFields) {
        const label = field.label || field.name || field.type;
        const selector = field.selector;
        const value = generateFieldValue(field);

        if (field.type === 'select' && field.options?.length) {
          steps.push(`Select "${field.options[0]}" from the ${label} dropdown (${selector})`);
        } else if (field.type === 'checkbox' || field.type === 'radio') {
          steps.push(`Check the ${label} ${field.type} (${selector})`);
        } else {
          steps.push(`Type '${value}' into the ${label} field (${selector})`);
        }
      }
      steps.push(`Click the ${submitAction?.label ?? 'Submit'} button${submitSelector ? ` (${submitSelector})` : ''}`);
    } else if (title.includes('edit') || title.includes('update')) {
      steps.push('Select an existing item to edit');
      const editableFields = targetPage.formFields.filter((f) => f.type !== 'hidden');
      if (editableFields.length > 0) {
        const field = editableFields[0];
        steps.push(`Clear and type a new value into the ${field.label || field.name || field.type} field (${field.selector})`);
      }
      steps.push(`Click the ${submitAction?.label ?? 'Save'} button${submitSelector ? ` (${submitSelector})` : ''}`);
    } else {
      // Generic form interaction with real fields
      const requiredFields = targetPage.formFields.filter((f) => f.required);
      if (requiredFields.length > 0) {
        for (const field of requiredFields.slice(0, 5)) {
          const label = field.label || field.name || field.type;
          steps.push(`Fill in the ${label} field (${field.selector}) with valid test data`);
        }
      } else {
        steps.push(`Interact with the form fields on this page`);
      }
      if (submitSelector) {
        steps.push(`Click the submit button (${submitSelector})`);
      }
    }

    // Use observed outcomes for assertion
    const successOutcome = targetPage.formOutcomes?.find((o) => o.result === 'success');
    const errorOutcome = targetPage.formOutcomes?.find((o) => o.result === 'validation_error');

    if (imported.type === 'negative' && errorOutcome?.resultMessage) {
      steps.push(`Verify that the error message "${errorOutcome.resultMessage}" is visible`);
    } else if (successOutcome?.resultMessage) {
      steps.push(`Verify that the success message "${successOutcome.resultMessage}" is visible`);
    } else if (imported.type === 'negative') {
      steps.push('Verify that an appropriate error message is displayed');
    } else {
      steps.push('Verify the operation completed successfully');
    }
  } else {
    // No graph data — pure title-based generic fallback
    if (title.includes('create') || title.includes('add') || title.includes('new')) {
      steps.push('Click the Create / Add / New button to open the form');
      steps.push('Fill in all required fields with valid test data');
      steps.push('Click the Submit / Save button');
    } else if (title.includes('edit') || title.includes('update') || title.includes('modify')) {
      steps.push('Select an existing item to edit');
      steps.push('Modify the relevant fields with new values');
      steps.push('Click the Save / Update button');
    } else if (title.includes('delete') || title.includes('remove')) {
      steps.push('Select the item to delete');
      steps.push('Click the Delete / Remove button');
      steps.push('Confirm the deletion if a dialog appears');
    } else if (title.includes('login') || title.includes('sign in')) {
      steps.push('Enter username/email in the login field');
      steps.push('Enter password in the password field');
      steps.push('Click the Sign In / Login button');
    } else if (title.includes('search') || title.includes('filter')) {
      steps.push('Enter a search term in the search field');
      steps.push('Submit the search or apply the filter');
    } else {
      steps.push(`Perform the action described: "${imported.title}"`);
    }

    if (imported.type === 'negative') {
      steps.push('Verify that an appropriate error message is displayed');
    } else if (imported.type === 'edge') {
      steps.push('Verify the application handles the edge case gracefully');
    } else {
      steps.push('Verify that the expected success state is achieved');
    }
  }

  return steps;
}

/**
 * Find the most relevant page in the graph for a test title.
 */
function findTargetPage(title: string, startUrl: string | undefined, graph?: InteractionGraphLike) {
  if (!graph || graph.nodes.length === 0) return undefined;

  // Exact URL match first
  if (startUrl) {
    const exact = graph.nodes.find((n) => n.url === startUrl);
    if (exact) return exact;
  }

  // Keyword-based matching
  const keywords = title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  let bestNode: typeof graph.nodes[0] | undefined;
  let bestScore = 0;

  for (const node of graph.nodes) {
    let score = 0;
    const nodeText = `${node.title} ${node.url}`.toLowerCase();
    for (const kw of keywords) {
      if (nodeText.includes(kw)) score += 2;
    }
    // Boost nodes that have form fields (more likely to be actionable)
    if (node.formFields && node.formFields.length > 0) score += 3;
    if (score > bestScore) {
      bestScore = score;
      bestNode = node;
    }
  }

  return bestScore >= 3 ? bestNode : undefined;
}

/**
 * Generate a realistic test value for a form field based on its metadata.
 */
function generateFieldValue(field: { type: string; name?: string; label?: string; options?: string[]; min?: string; max?: string }): string {
  const label = (field.label || field.name || '').toLowerCase();
  switch (field.type) {
    case 'email': return 'qatest@example.com';
    case 'tel': return '+1-555-0123';
    case 'url': return 'https://example.com/test';
    case 'number': return field.min ?? '42';
    case 'date': return '2025-06-15';
    case 'password': return 'SecurePass123!';
    case 'textarea': return 'Test description for automated QA validation.';
    case 'select': return field.options?.[0] ?? 'Option 1';
    default:
      if (label.includes('name')) return 'Test User';
      if (label.includes('title') || label.includes('room')) return 'Test Item Alpha';
      if (label.includes('email')) return 'qatest@example.com';
      if (label.includes('company')) return 'Test Corp';
      if (label.includes('address')) return '123 Test Street';
      if (label.includes('description')) return 'Automated test description';
      return 'Test input value';
  }
}

function validateType(raw: unknown): TestCase['type'] | undefined {
  if (raw === 'positive' || raw === 'negative' || raw === 'edge') return raw;
  return undefined;
}
