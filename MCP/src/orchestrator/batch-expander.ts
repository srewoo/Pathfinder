import type { AIClientInterface } from '../core/ai/ai-client.js';
import type { TestCase } from '../storage/schemas.js';
import { PROMPTS } from '../core/ai/prompt-templates.js';
import { searchByText, formatSearchResults } from '../core/knowledge/vector-search.js';
import { loadGraph, serializeGraphForAI, extractAllFormFields, serializeNavigationMap } from '../core/explorer/interaction-graph.js';
import { getAllFlows, serializeFlowsForAI } from '../core/flow/flow-store.js';
import { generateId } from '../utils/hash.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('expander');

export async function expandOneLiner(title: string, aiClient: AIClientInterface, startUrl?: string): Promise<TestCase> {
  const [graph, flows] = await Promise.all([loadGraph(), getAllFlows()]);

  let knowledgeContext = 'No documentation indexed.';
  try {
    const results = await searchByText(title, (t) => aiClient.embed(t), 5, {
      useAIReranker: true,
      aiClient,
    });
    knowledgeContext = formatSearchResults(results);
  } catch { /* non-fatal */ }

  const graphContext = graph ? serializeGraphForAI(graph) : 'No exploration data.';
  const flowsContext = serializeFlowsForAI(flows);
  const formFieldsContext = graph ? extractAllFormFields(graph) : undefined;
  const navigationMapContext = graph ? serializeNavigationMap(graph) : undefined;

  const prompt = PROMPTS.testExpansion;
  const raw = await aiClient.chat(
    [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user({ title, startUrl }, knowledgeContext, graphContext, flowsContext, formFieldsContext, navigationMapContext) },
    ],
    { temperature: 0.2, jsonMode: true, maxTokens: 8192 }
  );

  const parsed = JSON.parse(raw.replace(/```json\n?|\n?```/g, '').trim());

  return {
    id: generateId(),
    title: parsed.title ?? title,
    description: parsed.description ?? '',
    type: parsed.type ?? 'positive',
    source: 'user',
    steps: Array.isArray(parsed.steps) ? parsed.steps : [],
    startUrl: parsed.startUrl ?? startUrl,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
}

export async function expandBatch(oneLiners: string[], aiClient: AIClientInterface, batchSize: number, startUrl?: string): Promise<TestCase[]> {
  const results: TestCase[] = [];
  for (let i = 0; i < oneLiners.length; i += batchSize) {
    const batch = oneLiners.slice(i, i + batchSize);
    const expanded = await Promise.all(batch.map((line) => expandOneLiner(line, aiClient, startUrl).catch((err) => {
      log.error(`Failed to expand: ${line}`, err);
      return { id: generateId(), title: line, description: 'Expansion failed', type: 'positive' as const, source: 'user' as const, status: 'error' as const, createdAt: new Date().toISOString() };
    })));
    results.push(...expanded);
  }
  log.info(`Expanded ${results.length} one-liners`);
  return results;
}
