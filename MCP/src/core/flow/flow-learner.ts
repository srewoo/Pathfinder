import type { AIClientInterface } from '../ai/ai-client.js';
import type {
  Flow,
  FlowStep,
  InteractionGraph,
  PageNode,
  PageEdge,
  StartUrlInference,
} from '../../storage/schemas.js';
import { PROMPTS } from '../ai/prompt-templates.js';
import { serializeGraphForFlowLearning, loadGraph } from '../explorer/interaction-graph.js';
import { searchByText, formatSearchResults } from '../knowledge/vector-search.js';
import { saveFlow } from './flow-store.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('flow-learner');

const MAX_GRAPH_CHARS = 150_000;
const BATCH_ACTIONABLE_PAGES = 80;

function truncateGraphContext(raw: string): string {
  if (raw.length <= MAX_GRAPH_CHARS) return raw;
  const truncated = raw.slice(0, MAX_GRAPH_CHARS);
  const lastNewline = truncated.lastIndexOf('\n');
  return (lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated) +
    '\n\n[Graph truncated — site is large. Remaining pages omitted.]';
}

function buildRAGQuery(graph: InteractionGraph | undefined): string {
  if (!graph || graph.nodes.length === 0) {
    return 'user workflows features navigation steps';
  }

  const pageTitles = graph.nodes
    .map((n) => n.title)
    .filter((t) => t && t !== '...')
    .slice(0, 10);

  const formLabels = graph.nodes
    .flatMap((n) => n.formFields ?? [])
    .map((f) => f.label || f.name || f.placeholder)
    .filter(Boolean)
    .slice(0, 10);

  const parts = [
    ...pageTitles,
    ...formLabels,
    'user workflows',
    'form submission',
  ];

  return parts.join(' ');
}

export async function learnFlows(aiClient: AIClientInterface): Promise<Flow[]> {
  const graph = await loadGraph();

  let knowledgeContext = 'No product documentation indexed yet.';
  try {
    const ragQuery = buildRAGQuery(graph);
    const knowledgeResults = await searchByText(ragQuery, (texts) => aiClient.embed(texts), 5);
    knowledgeContext = formatSearchResults(knowledgeResults);
  } catch (err) {
    log.warn('Knowledge search failed during flow learning — continuing without RAG context', err);
  }

  const compactGraph = graph ? serializeGraphForFlowLearning(graph) : 'No exploration data available.';

  let allParsed: Array<Omit<Flow, 'flowId' | 'createdAt' | 'updatedAt'>>;

  if (compactGraph.length <= MAX_GRAPH_CHARS) {
    allParsed = await extractFlowsFromChunk(compactGraph, knowledgeContext, aiClient);
  } else {
    log.info(`Graph too large (${compactGraph.length} chars) — batching flow extraction`);
    allParsed = await extractFlowsBatched(graph!, knowledgeContext, aiClient);
  }

  const seen = new Set<string>();
  const deduped = allParsed.filter((f) => {
    const key = f.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const saved: Flow[] = [];
  for (const flowData of deduped) {
    try {
      const startDetails = inferFlowStartDetails(graph, flowData);
      const flow = await saveFlow({
        name: flowData.name,
        description: flowData.description,
        steps: flowData.steps,
        startUrl: startDetails?.url,
        startUrlInference: startDetails?.inference,
        source: flowData.source ?? 'hybrid',
      });
      saved.push(flow);
    } catch (err) {
      log.error('Failed to save flow', { flow: flowData.name, err });
    }
  }

  log.info(`Learned ${saved.length} flows`);
  return saved;
}

async function extractFlowsFromChunk(
  explorationData: string,
  knowledgeContext: string,
  aiClient: AIClientInterface
): Promise<Array<Omit<Flow, 'flowId' | 'createdAt' | 'updatedAt'>>> {
  const prompt = PROMPTS.flowExtraction;
  let raw: string;
  try {
    raw = await aiClient.chat(
      [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user(truncateGraphContext(explorationData), knowledgeContext) },
      ],
      { temperature: 0.2, jsonMode: true, maxTokens: 16_384, timeoutMs: 180_000 }
    );
  } catch (err) {
    log.error('Flow extraction LLM call failed', err);
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Flow learning failed: ${message}`);
  }
  return parseFlowsResponse(raw);
}

async function extractFlowsBatched(
  graph: InteractionGraph,
  knowledgeContext: string,
  aiClient: AIClientInterface
): Promise<Array<Omit<Flow, 'flowId' | 'createdAt' | 'updatedAt'>>> {
  const actionable = graph.nodes.filter((n) =>
    (n.formFields && n.formFields.length > 0) ||
    (n.modals && n.modals.length > 0) ||
    (n.formOutcomes && n.formOutcomes.length > 0)
  );
  const navOnly = graph.nodes.filter((n) =>
    !(n.formFields && n.formFields.length > 0) &&
    !(n.modals && n.modals.length > 0) &&
    !(n.formOutcomes && n.formOutcomes.length > 0)
  );

  const batches: typeof actionable[] = [];
  for (let i = 0; i < actionable.length; i += BATCH_ACTIONABLE_PAGES) {
    batches.push(actionable.slice(i, i + BATCH_ACTIONABLE_PAGES));
  }
  if (batches.length === 0) batches.push([]);

  log.info(`Batching ${actionable.length} actionable pages into ${batches.length} AI calls`);

  const results = await Promise.allSettled(
    batches.map((batch, idx) => {
      const batchGraph = { ...graph, nodes: [...batch, ...navOnly] };
      const chunk = serializeGraphForFlowLearning(batchGraph);
      log.info(`Batch ${idx + 1}/${batches.length}: ${chunk.length} chars`);
      return extractFlowsFromChunk(chunk, knowledgeContext, aiClient);
    })
  );

  const all: Array<Omit<Flow, 'flowId' | 'createdAt' | 'updatedAt'>> = [];
  for (const r of results) {
    if (r.status === 'fulfilled') all.push(...r.value);
    else log.warn(`Batch flow extraction failed: ${r.reason}`);
  }
  return all;
}

export function inferFlowStartUrl(
  graph: InteractionGraph | undefined,
  flow: Pick<Flow, 'name' | 'description' | 'steps'>
): string | undefined {
  return inferFlowStartDetails(graph, flow)?.url;
}

export function inferFlowStartDetails(
  graph: InteractionGraph | undefined,
  flow: Pick<Flow, 'name' | 'description' | 'steps'>
): { url: string; inference: StartUrlInference } | undefined {
  if (!graph || graph.nodes.length === 0) return undefined;

  const explicitUrl = getExplicitStartUrl(flow.steps, graph.nodes);
  if (explicitUrl) {
    return {
      url: explicitUrl.url,
      inference: {
        method: 'navigate_step',
        confidence: 'high',
        score: 100,
        reason: explicitUrl.reason,
      },
    };
  }

  const firstActionableStep = flow.steps.find((step) => step.action !== 'navigate');
  const edgeScores = scoreEdgesForFlow(graph.edges, graph.nodes, flow, firstActionableStep);
  const bestEdgeMatch = pickBestCandidate(edgeScores);
  if (bestEdgeMatch) {
    return {
      url: bestEdgeMatch.url,
      inference: {
        method: 'edge_match',
        confidence: confidenceFromScore(bestEdgeMatch.score),
        score: bestEdgeMatch.score,
        reason: bestEdgeMatch.reason,
      },
    };
  }

  const nodeScores = scoreNodesForFlow(graph.nodes, flow, firstActionableStep);
  const bestNodeMatch = pickBestCandidate(nodeScores);
  if (!bestNodeMatch) return undefined;

  return {
    url: bestNodeMatch.url,
    inference: {
      method: 'node_match',
      confidence: confidenceFromScore(bestNodeMatch.score),
      score: bestNodeMatch.score,
      reason: bestNodeMatch.reason,
    },
  };
}

function getExplicitStartUrl(
  steps: FlowStep[],
  nodes: PageNode[]
): { url: string; reason: string } | undefined {
  const navigateStep = steps.find((step) => step.action === 'navigate' && step.value);
  if (!navigateStep?.value) return undefined;

  const normalized = normalizeUrl(navigateStep.value);
  const matchedNode = nodes.find((node) => normalizeUrl(node.url) === normalized);
  const resolvedUrl = matchedNode?.url ?? navigateStep.value;
  return {
    url: resolvedUrl,
    reason: matchedNode
      ? `The flow already contains a navigate step to the explored page "${matchedNode.title || matchedNode.url}".`
      : 'The flow already contains an explicit navigate step, so pathfinder uses that as the starting page.',
  };
}

function scoreEdgesForFlow(
  edges: PageEdge[],
  nodes: PageNode[],
  flow: Pick<Flow, 'name' | 'description' | 'steps'>,
  firstActionableStep: FlowStep | undefined
): CandidateScore[] {
  const scores: CandidateScore[] = [];
  if (!firstActionableStep) return scores;

  const targetTokens = tokenize([
    firstActionableStep.target,
    firstActionableStep.description,
    firstActionableStep.value,
    flow.name,
  ].join(' '));

  for (const edge of edges) {
    const destinationNode = nodes.find((node) => node.url === edge.to);
    const edgeTokens = tokenize([
      edge.label,
      edge.selector,
      destinationNode?.title,
      destinationNode?.url,
    ].join(' '));
    const overlap = countOverlap(targetTokens, edgeTokens);
    if (overlap === 0) continue;

    const score = overlap * 5 + similarityScore(firstActionableStep, edge, destinationNode);
    scores.push({
      url: edge.from,
      score,
      reason: destinationNode
        ? `The first actionable step best matches the "${edge.label}" transition into "${destinationNode.title || destinationNode.url}".`
        : `The first actionable step best matches the "${edge.label}" transition from exploration data.`,
    });
  }

  return scores;
}

function scoreNodesForFlow(
  nodes: PageNode[],
  flow: Pick<Flow, 'name' | 'description' | 'steps'>,
  firstActionableStep: FlowStep | undefined
): CandidateScore[] {
  const scores: CandidateScore[] = [];
  const flowTokens = tokenize([
    flow.name,
    flow.description,
    ...(firstActionableStep
      ? [firstActionableStep.target, firstActionableStep.description, firstActionableStep.value]
      : []),
  ].join(' '));

  for (const node of nodes) {
    const nodeTokens = tokenize(`${node.title} ${node.url}`);
    const overlap = countOverlap(flowTokens, nodeTokens);
    if (overlap === 0) continue;

    scores.push({
      url: node.url,
      score: overlap * 2,
      reason: `The flow name/description most closely matches the explored page "${node.title || node.url}".`,
    });
  }

  return scores;
}

function similarityScore(
  step: FlowStep,
  edge: PageEdge,
  destinationNode: PageNode | undefined
): number {
  let score = 0;
  const stepText = [step.target, step.description, step.value].join(' ').toLowerCase();
  const edgeLabel = edge.label.toLowerCase();
  const destinationTitle = destinationNode?.title.toLowerCase() ?? '';

  if (step.target && edgeLabel.includes(step.target.toLowerCase())) score += 4;
  if (stepText && edge.selector.toLowerCase().includes(stepText.split(' ')[0] ?? '')) score += 1;
  if (destinationTitle && stepText.includes(destinationTitle)) score += 2;

  return score;
}

function pickBestCandidate(scores: CandidateScore[]): CandidateScore | undefined {
  return scores.reduce<CandidateScore | undefined>((best, candidate) => {
    if (!best) return candidate;
    return candidate.score > best.score ? candidate : best;
  }, undefined);
}

function tokenize(input: string): Set<string> {
  return new Set(
    input
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .filter((token) => token.length >= 3)
  );
}

function countOverlap(a: Set<string>, b: Set<string>): number {
  let matches = 0;
  for (const token of a) {
    if (b.has(token)) matches++;
  }
  return matches;
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return url;
  }
}

function confidenceFromScore(score: number): StartUrlInference['confidence'] {
  if (score >= 10) return 'high';
  if (score >= 5) return 'medium';
  return 'low';
}

interface CandidateScore {
  url: string;
  score: number;
  reason: string;
}

function parseFlowsResponse(raw: string): Array<Omit<Flow, 'flowId' | 'createdAt' | 'updatedAt'>> {
  let json: unknown;
  const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();

  try {
    json = JSON.parse(cleaned);
  } catch {
    // The response may have been truncated (finish_reason=length).
    // Try to repair: close any open arrays/objects so we can salvage partial flows.
    json = tryRepairTruncatedJson(cleaned);
    if (!json) {
      log.warn('Failed to parse flows JSON (even after repair attempt)', { rawLength: raw.length });
      return [];
    }
    log.info('Salvaged partial flows from truncated LLM response');
  }

  if (typeof json !== 'object' || json === null) return [];

  const obj = json as Record<string, unknown>;
  const flows = Array.isArray(obj['flows']) ? obj['flows'] : [];

  return flows
    .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
    .filter((f) => f['name'] && f['steps']) // Only keep flows that have at least name + steps
    .map((f) => ({
      name: String(f['name'] ?? 'Unnamed Flow'),
      description: String(f['description'] ?? ''),
      source: (f['source'] as Flow['source']) ?? 'hybrid',
      steps: parseSteps(f['steps']),
    }));
}

/**
 * Attempt to repair truncated JSON from a cut-off LLM response.
 * The model was generating a `{ "flows": [ ... ] }` structure and got cut off.
 * We try progressively trimming from the end and closing brackets until it parses.
 */
function tryRepairTruncatedJson(raw: string): unknown | undefined {
  const closings = [']}', ']}]', '"]}', '"}]}', '"]}}]}'];
  for (const suffix of closings) {
    // Try closing at progressively earlier positions
    for (let trim = 0; trim < 500; trim += 1) {
      const candidate = raw.slice(0, raw.length - trim) + suffix;
      try {
        return JSON.parse(candidate);
      } catch {
        // keep trying
      }
    }
  }
  return undefined;
}

function parseSteps(raw: unknown): FlowStep[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
    .map((s, idx) => ({
      order: Number(s['order'] ?? idx + 1),
      action: String(s['action'] ?? 'click'),
      target: s['target'] ? String(s['target']) : undefined,
      value: s['value'] ? String(s['value']) : undefined,
      description: String(s['description'] ?? ''),
      selector: s['selector'] ? String(s['selector']) : undefined,
      expectedOutcome: s['expectedOutcome'] ? String(s['expectedOutcome']) : undefined,
    }));
}
