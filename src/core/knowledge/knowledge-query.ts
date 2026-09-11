/**
 * Ask the knowledge base a question and get back the evidence, not a verdict.
 *
 * Retrieval already runs inside test generation, flow learning and the
 * doc-grounded oracle — but only ever as an invisible step whose output reaches
 * the user as finished prose. When that prose cites something the corpus does
 * not contain, there was no way to find out. This module exposes the same
 * pipeline directly: the passages, where each came from, when it was crawled,
 * and where it ranked.
 *
 * Two rules shape the result type:
 *
 * 1. **An empty result is not one thing.** "Nothing is indexed", "nothing
 *    scored above threshold" and "your query was embedded at a dimension this
 *    index cannot be compared against" all arrive as zero passages from the
 *    search functions. A user shown a bare "no results" for the third will
 *    reword their query forever. Each is reported as its own `outcome`.
 *
 * 2. **A score is a ranking signal, not a probability.** The numbers here are a
 *    weighted blend of normalised cosine similarity and BM25, re-ranked for
 *    diversity; they order passages against each other within one query and
 *    mean nothing across queries. The field is named and documented so nobody
 *    renders it as a confidence percentage.
 */
import type { AIClientInterface } from '../ai/ai-client';
import { searchByText, describeIndex } from './vector-search';
import { createLogger } from '../../utils/logger';

const log = createLogger('knowledge-query');

/** Beyond this, a passage's source is old enough that the product may have moved on. */
export const STALE_AFTER_DAYS = 90;

export interface RetrievedPassage {
  /** Vector record id — the same id citations resolve against. */
  id: string;
  /** The indexed text itself. This is what generation actually saw. */
  content: string;
  url: string;
  title: string;
  section: string;
  breadcrumbPath?: string;
  /** When this passage's page was crawled. */
  crawledAt: string;
  /** True when `crawledAt` is older than {@link STALE_AFTER_DAYS}. */
  stale: boolean;
  /** Which chunk of its document this is — context for a passage that reads mid-thought. */
  chunkIndex: number;
  totalChunks: number;
  embeddingModel?: string;
  /**
   * Rank position, 1-based. Unlike the score, this is meaningful on its own.
   */
  rank: number;
  /**
   * RANKING SIGNAL, not a calibrated probability.
   *
   * A blend of normalised cosine similarity and BM25 after diversity
   * re-ranking. Comparable between passages within this one result set, and
   * not comparable to a score from any other query. Never render it as a
   * percentage confidence.
   */
  rankingScore: number;
}

export type QueryOutcome =
  /** Passages were found. */
  | { kind: 'results' }
  /** Nothing has been crawled yet. */
  | { kind: 'empty-index' }
  /** The corpus is indexed, but nothing scored above the relevance threshold. */
  | { kind: 'no-match' }
  /**
   * The query could not be compared against the index — the embedding model in
   * Settings produces vectors of a different dimension than the corpus was
   * built with. Re-crawling with the current model is the fix, and no amount of
   * rewording is.
   */
  | { kind: 'embedding-mismatch'; queryDimensions: number; indexDimensions: number }
  /** Embedding the query failed — no API key, a provider error, a timeout. */
  | { kind: 'unavailable'; reason: string };

export interface KnowledgeQueryResult {
  query: string;
  outcome: QueryOutcome;
  passages: RetrievedPassage[];
  /** State of the corpus at query time, so the answer can be read in context. */
  index: {
    vectors: number;
    documents: number;
    dimensions: number;
    /** More than one model in the corpus means passages are not mutually comparable. */
    embeddingModels: string[];
    oldestCrawledAt?: string;
    newestCrawledAt?: string;
  };
  /** How many returned passages come from a page older than the staleness window. */
  stalePassages: number;
}

function isStale(crawledAt: string, now: number): boolean {
  const at = Date.parse(crawledAt);
  if (Number.isNaN(at)) return false;
  return now - at > STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
}

export interface KnowledgeQueryOptions {
  topK?: number;
  /** Restrict to one source page. */
  filterUrl?: string;
  /** Clock injection, so staleness is testable without waiting three months. */
  now?: number;
}

/**
 * Run a query through the shipped retrieval pipeline and return its evidence.
 *
 * Never throws: a question about the knowledge base must not be able to break
 * the panel asking it, and a failure to answer is itself an answer the user
 * needs ("no API key" is actionable; a blank pane is not).
 */
export async function queryKnowledge(
  query: string,
  aiClient: AIClientInterface,
  options: KnowledgeQueryOptions = {}
): Promise<KnowledgeQueryResult> {
  const { topK = 8, filterUrl, now = Date.now() } = options;

  const index = await describeIndex().catch(() => ({
    vectors: 0,
    documents: 0,
    dimensions: 0,
    embeddingModels: [] as string[],
    oldestCrawledAt: undefined,
    newestCrawledAt: undefined,
  }));

  const indexSummary = {
    vectors: index.vectors,
    documents: index.documents,
    dimensions: index.dimensions,
    embeddingModels: index.embeddingModels,
    oldestCrawledAt: index.oldestCrawledAt,
    newestCrawledAt: index.newestCrawledAt,
  };

  const trimmed = query.trim();
  if (!trimmed) {
    return { query, outcome: { kind: 'no-match' }, passages: [], index: indexSummary, stalePassages: 0 };
  }

  if (index.vectors === 0) {
    return { query: trimmed, outcome: { kind: 'empty-index' }, passages: [], index: indexSummary, stalePassages: 0 };
  }

  // Embedded here rather than inside `searchByText` so the dimension can be
  // compared against the index BEFORE the search silently returns nothing.
  let queryEmbedding: number[] | undefined;
  try {
    [queryEmbedding] = await aiClient.embed([trimmed]);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn('Query embedding failed', err);
    return {
      query: trimmed,
      outcome: { kind: 'unavailable', reason },
      passages: [],
      index: indexSummary,
      stalePassages: 0,
    };
  }

  if (!queryEmbedding || queryEmbedding.length === 0) {
    return {
      query: trimmed,
      outcome: { kind: 'unavailable', reason: 'The embedding model returned no vector for this query.' },
      passages: [],
      index: indexSummary,
      stalePassages: 0,
    };
  }

  if (index.dimensions > 0 && queryEmbedding.length !== index.dimensions) {
    return {
      query: trimmed,
      outcome: {
        kind: 'embedding-mismatch',
        queryDimensions: queryEmbedding.length,
        indexDimensions: index.dimensions,
      },
      passages: [],
      index: indexSummary,
      stalePassages: 0,
    };
  }

  let results;
  try {
    // The embedding is already computed; handing back the cached one keeps this
    // to a single embed call and guarantees the vector compared against the
    // index is the one whose dimension was just checked.
    results = await searchByText(trimmed, async () => [queryEmbedding!], topK, { filterUrl });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn('Knowledge search failed', err);
    return {
      query: trimmed,
      outcome: { kind: 'unavailable', reason },
      passages: [],
      index: indexSummary,
      stalePassages: 0,
    };
  }

  const passages: RetrievedPassage[] = results.map((r, i) => {
    const meta = r.record.metadata;
    const crawledAt = meta?.crawledAt ?? '';
    return {
      id: r.record.id,
      content: r.record.content,
      url: r.record.url,
      title: meta?.title ?? r.record.url,
      section: meta?.section ?? '',
      breadcrumbPath: meta?.breadcrumbPath,
      crawledAt,
      stale: crawledAt ? isStale(crawledAt, now) : false,
      chunkIndex: meta?.chunkIndex ?? 0,
      totalChunks: meta?.totalChunks ?? 1,
      embeddingModel: meta?.embeddingModel,
      rank: i + 1,
      rankingScore: r.score,
    };
  });

  return {
    query: trimmed,
    outcome: { kind: passages.length > 0 ? 'results' : 'no-match' },
    passages,
    index: indexSummary,
    stalePassages: passages.filter((p) => p.stale).length,
  };
}

/**
 * One sentence explaining an outcome, for a UI that must not render a blank
 * pane and call it an answer.
 */
export function explainOutcome(result: KnowledgeQueryResult): string {
  const { outcome, index } = result;
  switch (outcome.kind) {
    case 'results':
      return `${result.passages.length} passage${result.passages.length === 1 ? '' : 's'} from ${index.documents} indexed document${index.documents === 1 ? '' : 's'}.`;
    case 'empty-index':
      return 'Nothing is indexed yet — crawl a documentation site first.';
    case 'no-match':
      return `Nothing in the ${index.documents} indexed document${index.documents === 1 ? '' : 's'} scored above the relevance threshold. The documentation may not cover this.`;
    case 'embedding-mismatch':
      return `This query embeds to ${outcome.queryDimensions} dimensions but the index was built at ${outcome.indexDimensions}. They cannot be compared — re-crawl with the embedding model currently set in Settings.`;
    case 'unavailable':
      return `Could not run the query: ${outcome.reason}`;
  }
}
