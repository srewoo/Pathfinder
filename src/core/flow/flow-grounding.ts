import type { KnowledgeRef } from '../../storage/schemas';
import type { FlowDraft } from './skeleton-enumerator';
import { search, type SearchResult } from '../knowledge/vector-search';
import { createLogger } from '../../utils/logger';

const log = createLogger('flow-grounding');

/**
 * Phase 2 of the graph-first flow design: per-flow knowledge grounding.
 *
 * The old design ran ONE global RAG query and stapled the same doc blob onto
 * every flow — knowledge barely influenced anything. Here we build a FOCUSED
 * query from each flow's own name + step targets + start-URL terms, retrieve the
 * docs about THAT feature, and attach them as `knowledgeRefs`. A flow that lands
 * real documentation is promoted from 'exploration' to 'hybrid'.
 *
 * Cost discipline: we embed ALL flow queries in a SINGLE batched `embed()` call,
 * then do in-memory vector search per flow (no per-flow LLM, no per-flow embed).
 * Grounding never blocks flow learning — on any failure we return flows unchanged.
 */

export type EmbedFn = (texts: string[]) => Promise<number[][]>;
export type GroundSearchFn = (embedding: number[], topK: number) => Promise<SearchResult[]>;

export interface GroundingOptions {
  /** Injectable for tests; defaults to the real vector-search. */
  searchFn?: GroundSearchFn;
  /** Docs retrieved per flow. Default 2. */
  topK?: number;
  /** Minimum hybrid score for a doc to count as grounding. Default 0.3. */
  minScore?: number;
  /** Max query chars sent to the embedder. Default 400. */
  maxQueryChars?: number;
}

const STOPWORDS = new Set([
  'open', 'click', 'verify', 'submit', 'navigate', 'the', 'and', 'for', 'with',
  'form', 'page', 'view', 'flow', 'auto', 'generated', 'enter', 'into', 'value',
]);

/** Humanize URL path segments into search terms (drops numeric / hex IDs). */
function urlTerms(url: string): string[] {
  try {
    return new URL(url).pathname
      .split('/')
      .filter((s) => s.length > 2 && !/^\d+$/.test(s) && !/^[0-9a-f]{8,}$/i.test(s))
      .map((s) => s.replace(/[-_]+/g, ' ').trim());
  } catch {
    return [];
  }
}

/**
 * Build a focused retrieval query for ONE flow from its own signals: name,
 * distinct step targets, and the start-URL path terms. Deduped + stopword-pruned
 * so the query is about the feature, not the verb scaffolding.
 */
export function buildFlowQuery(flow: FlowDraft, maxChars = 400): string {
  const targets = flow.steps.map((s) => s.target).filter((t): t is string => !!t);
  const navUrls = flow.steps.filter((s) => s.action === 'navigate' && s.value).map((s) => s.value!);
  const fromUrls = navUrls.flatMap(urlTerms);

  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of [flow.name, ...targets, ...fromUrls]) {
    for (const word of raw.split(/[^a-z0-9]+/i)) {
      const key = word.toLowerCase();
      if (key.length < 3 || STOPWORDS.has(key) || seen.has(key)) continue;
      seen.add(key);
      terms.push(word);
    }
  }
  const query = terms.join(' ');
  return query.length > maxChars ? query.slice(0, maxChars) : query;
}

function toRef(result: SearchResult): KnowledgeRef {
  return {
    url: result.record.url,
    section: result.record.metadata.section || undefined,
    score: Math.round(result.score * 1000) / 1000,
    snippet: result.record.content.slice(0, 200),
  };
}

/**
 * Ground each flow against indexed documentation. Returns a NEW array; inputs
 * are not mutated. Flows that match docs gain `knowledgeRefs` and (if they were
 * 'exploration') are promoted to 'hybrid'.
 */
export async function groundFlows(
  flows: FlowDraft[],
  embed: EmbedFn,
  options: GroundingOptions = {}
): Promise<FlowDraft[]> {
  const { searchFn = (e, k) => search(e, k), topK = 2, minScore = 0.3, maxQueryChars = 400 } = options;
  if (flows.length === 0) return flows;

  let embeddings: number[][];
  try {
    const queries = flows.map((f) => buildFlowQuery(f, maxQueryChars) || f.name);
    embeddings = await embed(queries);
  } catch (err) {
    log.warn('Flow grounding skipped — embedding failed', err);
    return flows;
  }
  if (!embeddings || embeddings.length !== flows.length) {
    log.warn('Flow grounding skipped — embedding count mismatch');
    return flows;
  }

  let grounded = 0;
  const result = await Promise.all(
    flows.map(async (flow, i) => {
      const embedding = embeddings[i];
      if (!embedding || embedding.length === 0) return flow;
      let hits: SearchResult[];
      try {
        hits = await searchFn(embedding, topK);
      } catch {
        return flow;
      }
      const refs = hits.filter((h) => h.score >= minScore).map(toRef);
      if (refs.length === 0) return flow;
      grounded++;
      return {
        ...flow,
        knowledgeRefs: refs,
        // A flow backed by docs is hybrid; documentation-sourced flows stay so.
        source: flow.source === 'documentation' ? 'documentation' : 'hybrid',
      } as FlowDraft;
    })
  );

  log.info(`Per-flow grounding: ${grounded}/${flows.length} flows matched documentation`);
  return result;
}
