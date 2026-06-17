import type { AIClientInterface } from '../ai/ai-client';
import type {
  Flow,
  FlowStep,
  InteractionGraph,
  PageNode,
  PageEdge,
  StartUrlInference,
} from '../../storage/schemas';
import { PROMPTS } from '../ai/prompt-templates';
import { serializeGraphForFlowLearning, loadGraph } from '../explorer/interaction-graph';
import { searchByText, formatSearchResults } from '../knowledge/vector-search';
import { saveFlow, updateFlow, getAllFlows } from './flow-store';
import { enumerateSkeletons, dedupeBySignature } from './skeleton-enumerator';
import { groundFlows } from './flow-grounding';
import { reconcileFlows, staleMark, reviveMark } from './flow-reconciler';
import { createLogger } from '../../utils/logger';

const log = createLogger('flow-learner');

/**
 * ~150 000 chars ≈ 37 500 tokens. Modern models (gpt-4o, claude-3.5-sonnet)
 * have 128k+ context windows; this leaves plenty of room for system prompt,
 * knowledge context (~2k tokens) and response (~4k tokens).
 */
const MAX_GRAPH_CHARS = 60_000;

/**
 * If the compact-serialized graph is still larger than MAX_GRAPH_CHARS, split
 * it into roughly equal batches so each fits within the budget.
 */
const BATCH_ACTIONABLE_PAGES = 25;

/**
 * Jaccard similarity threshold for semantic flow deduplication. Higher values
 * preserve more flows; we keep this loose enough to dedup near-duplicates but
 * tight enough that parallel admin/learner workflows survive.
 */
const FLOW_DEDUP_THRESHOLD = 0.78;

function truncateGraphContext(raw: string): string {
  if (raw.length <= MAX_GRAPH_CHARS) return raw;
  const truncated = raw.slice(0, MAX_GRAPH_CHARS);
  // Find last complete object/line boundary to avoid mid-value corruption in JSON
  const lastObjectEnd = Math.max(
    truncated.lastIndexOf('},\n'),
    truncated.lastIndexOf('}\n'),
    truncated.lastIndexOf('\n\n')
  );
  const cutPoint = lastObjectEnd > 0 ? lastObjectEnd + 1 : truncated.lastIndexOf('\n');
  return (cutPoint > 0 ? truncated.slice(0, cutPoint) : truncated) +
    '\n\n[Graph truncated — site is large. Remaining pages omitted.]';
}

/**
 * Extract human-meaningful terms from a URL path: humanized non-ID segments.
 * e.g. "/new/ui/callai/recording/5993642928991842993" → ["callai", "recording"].
 */
export function pathTerms(url: string): string[] {
  try {
    return new URL(url).pathname
      .split('/')
      .filter((s) => s.length > 2)
      .filter((s) => !/^\d+$/.test(s) && !/^[0-9a-f]{8,}$/i.test(s)) // drop numeric/hex IDs
      .map((s) => s.replace(/[-_]+/g, ' ').trim());
  } catch {
    return [];
  }
}

export function buildRAGQuery(graph: InteractionGraph | undefined): string {
  if (!graph || graph.nodes.length === 0) {
    return 'user workflows features navigation steps';
  }

  const titles = graph.nodes.map((n) => n.title).filter((t): t is string => !!t && t !== '...');
  const headings = graph.nodes.flatMap((n) => n.headings ?? []);
  const tabLabels = graph.nodes.flatMap((n) => (n.tabs ?? []).map((t) => t.label));
  const actionLabels = graph.nodes.flatMap((n) => (n.actions ?? []).map((a) => a.label)).filter((l): l is string => !!l);
  const formLabels = graph.nodes
    .flatMap((n) => n.formFields ?? [])
    .map((f) => f.label || f.name || f.placeholder)
    .filter((l): l is string => !!l);
  // Fallback for feature pages with no usable title/forms (e.g. a recording
  // view titled "...") — derive meaning from the URL path itself.
  const urlTerms = graph.nodes.flatMap((n) => pathTerms(n.url));

  // Dedup (case-insensitive), most descriptive signals first, capped so the
  // RAG query stays focused.
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const term of [...titles, ...headings, ...tabLabels, ...formLabels, ...actionLabels, ...urlTerms]) {
    const key = term.toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    ordered.push(term);
    if (ordered.length >= 40) break;
  }

  return [...ordered, 'user workflows features'].join(' ');
}

export async function learnFlows(aiClient: AIClientInterface): Promise<Flow[]> {
  const graph = await loadGraph();

  // Embed failure must not abort the whole flow.
  let knowledgeContext = 'No product documentation indexed yet.';
  try {
    const ragQuery = buildRAGQuery(graph);
    const knowledgeResults = await searchByText(ragQuery, (texts) => aiClient.embed(texts), 5);
    knowledgeContext = formatSearchResults(knowledgeResults);
  } catch (err) {
    log.warn('Knowledge search failed during flow learning — continuing without RAG context', err);
  }

  let allParsed: Array<Omit<Flow, 'flowId' | 'createdAt' | 'updatedAt'>>;

  if (!graph || graph.nodes.length === 0) {
    allParsed = await extractFlowsFromChunk('No exploration data available.', knowledgeContext, aiClient);
  } else {
    const partitions = partitionGraphBySubApp(graph);
    if (partitions.length > 1) {
      log.info(`Partitioned graph into ${partitions.length} sub-apps: ${partitions.map((p) => `${p.label} (${p.graph.nodes.length} pages)`).join(', ')}`);
      const results = await Promise.allSettled(
        partitions.map((p) => extractFlowsForPartition(p.graph, p.label, knowledgeContext, aiClient))
      );
      allParsed = [];
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === 'fulfilled') {
          // Dedup within each partition only — never collapse parallel
          // admin/learner workflows that legitimately mirror each other.
          const partitionDeduped = semanticDedup(r.value);
          log.info(`Partition "${partitions[i].label}": ${r.value.length} raw → ${partitionDeduped.length} after intra-partition dedup`);
          allParsed.push(...partitionDeduped);
        } else {
          log.error(`Partition "${partitions[i].label}" flow extraction failed`, r.reason);
        }
      }
    } else {
      allParsed = await extractFlowsForPartition(graph, partitions[0]?.label ?? 'app', knowledgeContext, aiClient);
    }
  }

  log.info(`LLM returned ${allParsed.length} flows after intra-partition dedup`);

  // Cross-partition dedup is unnecessary — partitions are by sub-app, so
  // there's nothing to merge. Skip a second dedup pass that would risk
  // collapsing legitimate parallel flows.
  let deduped = allParsed;

  // ── Graph-first skeleton backbone (Phase 1) ───────────────────────────
  // The interaction graph IS the universe of possible flows. Enumerate it
  // deterministically (navigation journeys, forms + negative paths, modals,
  // feature tabs, table row-actions) so completeness is a graph property —
  // not something the non-deterministic LLM call has to remember every time.
  // The LLM flows above stay FIRST in dedup order so the richest version of
  // any duplicated journey wins; skeletons fill the long tail the LLM drops.
  if (graph) {
    const skeletons = enumerateSkeletons(graph);
    const beforeMerge = deduped.length;
    deduped = dedupeBySignature([...deduped, ...skeletons]);
    log.info(`Graph backbone: enumerated ${skeletons.length} deterministic skeletons; ${deduped.length - beforeMerge} survived structural dedup against ${beforeMerge} LLM flows`);
  }

  // ── Coverage safety net ───────────────────────────────────────────────
  // For every page in the graph, ensure at least 2 flows reference it. The
  // skeletons above cover most pages; this backstops any page still under-
  // represented (e.g. nav-only pages with no edges, forms, or tabs).
  if (graph) {
    const filler = synthesizeCoverageFillers(graph, deduped);
    if (filler.length > 0) {
      log.info(`Coverage net: synthesized ${filler.length} gap-filler flows for under-covered pages`);
      deduped = dedupeBySignature([...deduped, ...filler]);
    }
  }

  // ── Per-flow knowledge grounding (Phase 2) ────────────────────────────
  // Ground EACH flow against the docs about ITS feature (one batched embed +
  // in-memory vector search). Flows that match documentation gain
  // `knowledgeRefs` and are promoted to 'hybrid'. Never blocks learning.
  try {
    deduped = await groundFlows(deduped, (texts) => aiClient.embed(texts));
  } catch (err) {
    log.warn('Per-flow grounding failed — saving flows without knowledge refs', err);
  }

  // ── Reconcile against stored flows (Phase 3) ──────────────────────────
  // Identity is the step SIGNATURE, not the name. A structurally-identical
  // flow updates the existing record in place (keeping its flowId so already-
  // generated test cases stay linked); a flow whose signature vanished is
  // marked stale (reversible), not deleted.
  const existing = await getAllFlows().catch(() => [] as Flow[]);
  const plan = reconcileFlows(deduped, existing);
  const nowIso = new Date().toISOString();

  const saved: Flow[] = [];
  for (const flowData of plan.toCreate) {
    try {
      const startDetails = inferFlowStartDetails(graph, flowData);
      const flow = await saveFlow({
        name: flowData.name,
        description: flowData.description,
        steps: flowData.steps,
        startUrl: startDetails?.url,
        startUrlInference: startDetails?.inference,
        source: flowData.source ?? 'hybrid',
        coverageType: flowData.coverageType,
        knowledgeRefs: flowData.knowledgeRefs,
        signature: flowData.signature,
      });
      saved.push(flow);
    } catch (err) {
      log.error('Failed to save flow', { flow: flowData.name, err });
    }
  }

  for (const { flowId, patch } of plan.toUpdate) {
    try {
      // A reappearing signature is, by definition, no longer stale.
      const updated = await updateFlow(flowId, { ...patch, ...reviveMark() });
      if (updated) saved.push(updated);
    } catch (err) {
      log.error('Failed to update flow', { flowId, err });
    }
  }
  for (const flowId of plan.toMarkStale) {
    await updateFlow(flowId, staleMark(nowIso)).catch((err) => log.error('Failed to mark flow stale', { flowId, err }));
  }

  log.info(
    `Reconciled flows: ${plan.toCreate.length} created, ${plan.toUpdate.length} updated, ${plan.toRevive.length} revived, ${plan.toMarkStale.length} marked stale`
  );
  return saved;
}

interface GraphPartition {
  label: string;
  graph: InteractionGraph;
}

/**
 * Split the exploration graph into sub-applications based on URL host + first
 * path segment (e.g. /admin vs /learner). This forces per-sub-app coverage so
 * the LLM cannot collapse parallel workflows from different apps into one flow.
 * Edges that cross partitions are kept in BOTH partitions so navigation context
 * is preserved.
 */
/**
 * Known sub-app keywords. If any URL path contains one of these as a segment,
 * we partition on it. Order matters — earlier wins on ties.
 */
const SUB_APP_KEYWORDS = ['admin', 'learner', 'manager', 'instructor', 'coach', 'reviewer', 'reps', 'analytics', 'app'];

function pathSegments(url: string): string[] {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).map((s) => s.toLowerCase());
  } catch {
    return [];
  }
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return 'unknown'; }
}

/**
 * Pick a sub-app label for a URL using:
 *   1. Known sub-app keyword anywhere in path (admin / learner / etc.)
 *   2. Otherwise the most discriminating path segment chosen at the call site.
 */
function subAppKey(url: string, discriminatorIdx: number | null): string {
  const host = hostOf(url);
  const segs = pathSegments(url);
  for (const kw of SUB_APP_KEYWORDS) {
    if (segs.includes(kw)) return `${host}#${kw}`;
  }
  if (discriminatorIdx !== null && segs[discriminatorIdx]) {
    return `${host}#${segs[discriminatorIdx]}`;
  }
  return host;
}

/**
 * Find the path-segment index that best splits the URLs into roughly equal
 * groups. Returns null if no segment produces a meaningful split.
 */
function findDiscriminatingSegment(urls: string[]): number | null {
  if (urls.length < 6) return null;
  const allSegs = urls.map(pathSegments);
  const maxLen = Math.max(...allSegs.map((s) => s.length));
  let bestIdx: number | null = null;
  let bestScore = 0;

  for (let idx = 0; idx < Math.min(maxLen, 5); idx++) {
    const counts = new Map<string, number>();
    for (const s of allSegs) {
      const v = s[idx];
      if (!v) continue;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    if (counts.size < 2) continue;
    // Score = number of groups with >= 5% of URLs. Prefer segments that
    // actually split the corpus into multiple non-trivial buckets.
    const total = urls.length;
    const significant = Array.from(counts.values()).filter((c) => c / total >= 0.05).length;
    if (significant >= 2 && significant > bestScore) {
      bestScore = significant;
      bestIdx = idx;
    }
  }
  return bestIdx;
}

function partitionGraphBySubApp(graph: InteractionGraph): GraphPartition[] {
  const urls = graph.nodes.map((n) => n.url);
  const discriminatorIdx = findDiscriminatingSegment(urls);

  const groups = new Map<string, PageNode[]>();
  for (const node of graph.nodes) {
    const k = subAppKey(node.url, discriminatorIdx);
    const list = groups.get(k) ?? [];
    list.push(node);
    groups.set(k, list);
  }

  if (groups.size <= 1) {
    return [{ label: groups.keys().next().value ?? 'app', graph }];
  }
  const total = graph.nodes.length;
  const significant = Array.from(groups.entries()).filter(([, nodes]) => nodes.length >= 3 && nodes.length / total >= 0.05);
  if (significant.length <= 1) {
    return [{ label: 'app', graph }];
  }

  return significant.map(([label, nodes]) => {
    const nodeUrls = new Set(nodes.map((n) => n.url));
    const edges = graph.edges.filter((e) => nodeUrls.has(e.from) || nodeUrls.has(e.to));
    return {
      label,
      graph: { ...graph, nodes, edges },
    };
  });
}

async function extractFlowsForPartition(
  graph: InteractionGraph,
  label: string,
  knowledgeContext: string,
  aiClient: AIClientInterface
): Promise<Array<Omit<Flow, 'flowId' | 'createdAt' | 'updatedAt'>>> {
  const compactGraph = serializeGraphForFlowLearning(graph);
  log.info(`Partition "${label}": ${graph.nodes.length} pages, ${compactGraph.length} chars`);
  if (compactGraph.length <= MAX_GRAPH_CHARS) {
    return extractFlowsFromChunk(compactGraph, knowledgeContext, aiClient);
  }
  log.info(`Partition "${label}" too large — batching by actionable pages`);
  return extractFlowsBatched(graph, knowledgeContext, aiClient);
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
      { temperature: 0.2, jsonMode: true, maxTokens: 16_384, timeoutMs: 240_000 }
    );
  } catch (err) {
    log.error('Flow extraction LLM call failed', err);
    const message = err instanceof DOMException && err.name === 'AbortError'
      ? 'Request timed out — the exploration data may be too large. Try exploring fewer pages.'
      : err instanceof Error ? err.message : String(err);
    throw new Error(`Flow learning failed: ${message}`);
  }
  return parseFlowsResponse(raw);
}

async function extractFlowsBatched(
  graph: InteractionGraph,
  knowledgeContext: string,
  aiClient: AIClientInterface
): Promise<Array<Omit<Flow, 'flowId' | 'createdAt' | 'updatedAt'>>> {
  // Split actionable pages into batches; include all nav-only pages compactly in each batch
  const actionable = graph.nodes.filter((n) =>
    (n.formFields && n.formFields.length > 0) ||
    (n.modals && n.modals.length > 0) ||
    (n.formOutcomes && n.formOutcomes.length > 0)
  );

  const batches: typeof actionable[] = [];
  for (let i = 0; i < actionable.length; i += BATCH_ACTIONABLE_PAGES) {
    batches.push(actionable.slice(i, i + BATCH_ACTIONABLE_PAGES));
  }
  if (batches.length === 0) batches.push([]);

  log.info(`Batching ${actionable.length} actionable pages into ${batches.length} AI calls`);

  // Pre-compute chunks for each batch so we can retry on failure
  const navOnly = graph.nodes.filter((n) =>
    !(n.formFields && n.formFields.length > 0) &&
    !(n.modals && n.modals.length > 0) &&
    !(n.formOutcomes && n.formOutcomes.length > 0)
  );
  const batchChunks = batches.map((batch, idx) => {
    const batchGraph = { ...graph, nodes: [...batch, ...navOnly] };
    const chunk = serializeGraphForFlowLearning(batchGraph);
    log.info(`Batch ${idx + 1}/${batches.length}: ${chunk.length} chars`);
    return chunk;
  });

  const results = await Promise.allSettled(
    batchChunks.map((chunk) => extractFlowsFromChunk(chunk, knowledgeContext, aiClient))
  );

  const all: Array<Omit<Flow, 'flowId' | 'createdAt' | 'updatedAt'>> = [];
  for (let idx = 0; idx < results.length; idx++) {
    const r = results[idx];
    if (r.status === 'fulfilled') {
      all.push(...r.value);
    } else {
      log.warn(`Batch ${idx + 1} flow extraction failed, retrying once`, r.reason);
      try {
        const retryResult = await extractFlowsFromChunk(batchChunks[idx], knowledgeContext, aiClient);
        all.push(...retryResult);
      } catch (retryErr) {
        log.error(`Batch ${idx + 1} retry also failed`, retryErr);
      }
    }
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

/**
 * Semantic deduplication of flows using Jaccard similarity on tokenized
 * name + description + first step description. Catches "Create User" vs
 * "New User" and "Login Flow" vs "User Login" as duplicates.
 */
function semanticDedup(
  flows: Array<Omit<Flow, 'flowId' | 'createdAt' | 'updatedAt'>>
): Array<Omit<Flow, 'flowId' | 'createdAt' | 'updatedAt'>> {
  const result: Array<Omit<Flow, 'flowId' | 'createdAt' | 'updatedAt'>> = [];

  for (const flow of flows) {
    const flowText = [
      flow.name,
      flow.description,
      flow.steps[0]?.description ?? '',
    ].join(' ');
    const flowTokens = tokenize(flowText);

    const isDuplicate = result.some((existing) => {
      const existingText = [
        existing.name,
        existing.description,
        existing.steps[0]?.description ?? '',
      ].join(' ');
      const existingTokens = tokenize(existingText);
      return jaccardSimilarity(flowTokens, existingTokens) >= FLOW_DEDUP_THRESHOLD;
    });

    if (!isDuplicate) {
      result.push(flow);
    } else {
      log.debug(`Deduped flow: "${flow.name}" (similar to existing flow)`);
    }
  }

  return result;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;

  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
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

/**
 * Coverage safety net: ensure every page in the graph has at least 2 flows
 * that reference it. For under-covered pages, synthesize deterministic
 * gap-filler flows so the test generator can still target them.
 *
 * Two filler types per page:
 *   1. "Navigate and Inspect" — visit the page and verify a key heading.
 *   2. A primary-action filler — click the most prominent button/link if any.
 */
export function synthesizeCoverageFillers(
  graph: InteractionGraph,
  existingFlows: Array<Omit<Flow, 'flowId' | 'createdAt' | 'updatedAt'>>
): Array<Omit<Flow, 'flowId' | 'createdAt' | 'updatedAt'>> {
  // Count how many existing flows reference each page URL (by exact URL or
  // by being the page's start URL via a navigate step).
  const refCount = new Map<string, number>();
  for (const node of graph.nodes) refCount.set(normalizeUrl(node.url), 0);

  for (const flow of existingFlows) {
    const referenced = new Set<string>();
    for (const step of flow.steps) {
      if (step.action === 'navigate' && step.value) {
        referenced.add(normalizeUrl(step.value));
      }
      if (step.action === 'navigate' && step.target && step.target.startsWith('http')) {
        referenced.add(normalizeUrl(step.target));
      }
    }
    for (const url of referenced) {
      if (refCount.has(url)) refCount.set(url, refCount.get(url)! + 1);
    }
  }

  const TARGET_FLOWS_PER_PAGE = 2;
  const fillers: Array<Omit<Flow, 'flowId' | 'createdAt' | 'updatedAt'>> = [];

  for (const node of graph.nodes) {
    if (node.isErrorPage) continue;
    const key = normalizeUrl(node.url);
    const have = refCount.get(key) ?? 0;
    const need = Math.max(0, TARGET_FLOWS_PER_PAGE - have);
    if (need === 0) continue;

    const pageLabel = node.title && node.title !== '...' ? node.title : pickPathLabel(node.url);

    // Filler 1 — navigate and inspect
    if (need >= 1) {
      const heading = (node.headings && node.headings[0]) || pageLabel;
      fillers.push({
        name: `Inspect: ${pageLabel}`,
        description: `Navigate to ${pageLabel} and verify the page rendered correctly. Auto-generated coverage filler.`,
        source: 'exploration',
        steps: [
          { order: 1, action: 'navigate', value: node.url, description: `Open ${pageLabel}`, target: node.url },
          { order: 2, action: 'verify', target: heading, description: `Verify "${heading}" is visible`, expectedOutcome: `"${heading}" is rendered on the page` },
        ],
      });
    }

    // Filler 2 — primary action click (use captured page action if available)
    if (need >= 2) {
      const primary = (node.actions ?? []).find((a) => a.kind === 'action' || a.kind === 'navigation');
      if (primary) {
        fillers.push({
          name: `Action: ${primary.label} on ${pageLabel}`,
          description: `Open ${pageLabel} and exercise the "${primary.label}" action. Auto-generated coverage filler.`,
          source: 'exploration',
          steps: [
            { order: 1, action: 'navigate', value: node.url, description: `Open ${pageLabel}`, target: node.url },
            {
              order: 2,
              action: 'click',
              target: primary.label,
              selector: primary.selector,
              description: `Click "${primary.label}"`,
              expectedOutcome: 'A modal opens, the page navigates, or a result is shown',
            },
          ],
        });
      } else {
        // No captured action — fall back to a second inspect flow that
        // checks a different signal (e.g. URL match or page-load network call)
        fillers.push({
          name: `Load: ${pageLabel}`,
          description: `Navigate to ${pageLabel} and confirm the page URL matches and finishes loading. Auto-generated coverage filler.`,
          source: 'exploration',
          steps: [
            { order: 1, action: 'navigate', value: node.url, description: `Open ${pageLabel}`, target: node.url },
            { order: 2, action: 'verify', target: 'page-url', value: node.url, description: `Verify the current URL equals ${node.url}`, expectedOutcome: `Browser URL bar shows ${node.url}` },
          ],
        });
      }
    }
  }

  // ── Feature-tab coverage: one flow per captured in-page tab/view ─────────
  // node.tabs are same-page query/hash views (e.g. ?aiFeatureTab=transcript).
  // normalizeUrl strips the query, so match tabs by their FULL URL instead.
  const coveredFullUrls = new Set<string>();
  for (const flow of existingFlows) {
    for (const step of flow.steps) {
      if (step.action === 'navigate' && step.value) coveredFullUrls.add(step.value);
    }
  }
  for (const node of graph.nodes) {
    if (node.isErrorPage || !node.tabs) continue;
    const pageLabel = node.title && node.title !== '...' ? node.title : pickPathLabel(node.url);
    for (const tab of node.tabs) {
      if (coveredFullUrls.has(tab.url)) continue;
      coveredFullUrls.add(tab.url); // avoid dupes within this run
      fillers.push({
        name: `Open ${tab.label} (${pageLabel})`,
        description: `Open the "${tab.label}" view and verify it loads. Auto-generated feature-tab coverage.`,
        source: 'exploration',
        steps: [
          { order: 1, action: 'navigate', value: tab.url, description: `Open ${tab.label}`, target: tab.url },
          { order: 2, action: 'verify', target: tab.label, description: `Verify the "${tab.label}" view is shown`, expectedOutcome: `The "${tab.label}" view is displayed` },
        ],
      });
    }
  }

  return fillers;
}

function pickPathLabel(url: string): string {
  try {
    const segs = new URL(url).pathname.split('/').filter(Boolean);
    const last = segs[segs.length - 1] ?? '';
    return last.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || url;
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
    .filter((f) => {
      const valid = f['name'] && f['steps'];
      if (!valid) log.debug('Discarding malformed flow entry (missing name or steps)', { keys: Object.keys(f) });
      return valid;
    })
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
  // Strategy 1: Find last complete object boundary and close the structure
  const lastCompleteObj = raw.lastIndexOf('}');
  if (lastCompleteObj > 0) {
    const suffixes = [']}', ']}]', '"]}}]}'];
    for (const suffix of suffixes) {
      try {
        return JSON.parse(raw.slice(0, lastCompleteObj + 1) + suffix);
      } catch { /* keep trying */ }
    }
  }

  // Strategy 2: Progressively trim from end (limited iterations for performance)
  const closings = [']}', ']}]', '"]}', '"}]}', '"]}}]}'];
  for (const suffix of closings) {
    for (let trim = 0; trim < 200; trim += 5) {
      try {
        return JSON.parse(raw.slice(0, raw.length - trim) + suffix);
      } catch { /* keep trying */ }
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
