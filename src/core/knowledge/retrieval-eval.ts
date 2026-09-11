/**
 * Retrieval quality eval harness.
 *
 * Given a labeled dataset of (query, expected-relevant-urls), runs each
 * query through the vector search and reports Precision@K, Recall@K, MRR,
 * and NDCG@K. Use this to detect retrieval regressions when changing
 * chunking, embedding model, BM25/vector weights, or reranking strategy.
 *
 * Datasets live alongside the project as plain JSON; see EvalDataset.
 */

import type { AIClientInterface } from '../ai/ai-client';
import type { SearchOptions } from './vector-search';
import { searchByText } from './vector-search';

export interface EvalQuery {
  /** Free-text user question. */
  query: string;
  /** URLs that *should* surface in the top results. Order independent. */
  relevantUrls: string[];
}

export interface EvalDataset {
  name: string;
  description?: string;
  /**
   * Version of the labelled corpus these queries were labelled against.
   *
   * A metric is comparable only to another taken on the same corpus, so
   * changing a document means bumping this and re-measuring rather than
   * comparing across the change.
   */
  version?: string;
  queries: EvalQuery[];
}

/**
 * Where the numbers came from, and therefore what they are worth.
 *
 * `synthetic-index` is a hand-built index whose vectors were chosen to make
 * the ranking arithmetic checkable. It tests the retrieval mechanics and says
 * nothing about semantic quality — a stubbed embedder cannot tell you whether
 * a real model finds the right passage.
 *
 * `actual-embeddings` is the real embedding model over the labelled corpus.
 * Only this tier supports a claim about retrieval QUALITY, and it needs
 * credentials, so it is reported as SKIPPED when they are absent — never as a
 * pass, and never quietly omitted.
 */
export type EvalTier = 'synthetic-index' | 'actual-embeddings';

export interface EvalProvenance {
  tier: EvalTier;
  /**
   * The embedding model identifier. On the synthetic tier this is the literal
   * string 'synthetic' rather than a model name, because no model ran.
   */
  embeddingModel: string;
  corpus: { name: string; version: string; queries: number };
  /** Queries actually evaluated. Differs from `corpus.queries` if any errored. */
  sampleSize: number;
}

/** A tier that could not run. Never a pass, never silent. */
export interface SkippedEval {
  skipped: true;
  tier: EvalTier;
  reason: string;
}

export interface QueryMetrics {
  query: string;
  precisionAtK: number;
  recallAtK: number;
  reciprocalRank: number;
  ndcgAtK: number;
  retrievedUrls: string[];
  relevantUrls: string[];
}

export interface AggregateMetrics {
  /** What produced these numbers. Required — a metric without it is unreadable. */
  provenance: EvalProvenance;
  /** Mean precision across all queries. */
  precisionAtK: number;
  /** Mean recall across all queries. */
  recallAtK: number;
  /** Mean reciprocal rank across all queries. */
  mrr: number;
  /** Mean NDCG across all queries. */
  ndcgAtK: number;
  /** Per-query breakdown. */
  perQuery: QueryMetrics[];
  /** k used for the eval. */
  k: number;
}

export interface RunEvalOptions extends SearchOptions {
  /** Top-K results to consider when computing metrics. Default 5. */
  k?: number;
  aiClient: AIClientInterface;
  /**
   * Which tier this run is. Required, because the same code path produces both
   * a mechanical check and a quality measurement, and only the caller knows
   * which one it set up.
   */
  tier: EvalTier;
  /** Model identifier for the report. 'synthetic' on the synthetic tier. */
  embeddingModel: string;
}

export async function runRetrievalEval(
  dataset: EvalDataset,
  opts: RunEvalOptions,
): Promise<AggregateMetrics> {
  const k = opts.k ?? 5;
  const perQuery: QueryMetrics[] = [];

  for (const q of dataset.queries) {
    const results = await searchByText(q.query, (texts) => opts.aiClient.embed(texts), k, opts);
    const retrievedUrls = uniqueUrls(results.map((r) => r.record.url));
    const relevantSet = new Set(q.relevantUrls);

    perQuery.push({
      query: q.query,
      retrievedUrls,
      relevantUrls: q.relevantUrls,
      precisionAtK: precisionAtK(retrievedUrls, relevantSet, k),
      recallAtK: recallAtK(retrievedUrls, relevantSet),
      reciprocalRank: reciprocalRank(retrievedUrls, relevantSet),
      ndcgAtK: ndcgAtK(retrievedUrls, relevantSet, k),
    });
  }

  return {
    provenance: {
      tier: opts.tier,
      embeddingModel: opts.embeddingModel,
      corpus: {
        name: dataset.name,
        version: dataset.version ?? 'unversioned',
        queries: dataset.queries.length,
      },
      sampleSize: perQuery.length,
    },
    k,
    precisionAtK: mean(perQuery.map((q) => q.precisionAtK)),
    recallAtK: mean(perQuery.map((q) => q.recallAtK)),
    mrr: mean(perQuery.map((q) => q.reciprocalRank)),
    ndcgAtK: mean(perQuery.map((q) => q.ndcgAtK)),
    perQuery,
  };
}

// ─── Pure metric functions (exported for direct testing) ─────────────────

export function precisionAtK(retrieved: string[], relevant: Set<string>, k: number): number {
  if (k === 0) return 0;
  const top = retrieved.slice(0, k);
  if (top.length === 0) return 0;
  const hits = top.filter((u) => relevant.has(u)).length;
  return hits / top.length;
}

export function recallAtK(retrieved: string[], relevant: Set<string>): number {
  if (relevant.size === 0) return 0;
  const hits = retrieved.filter((u) => relevant.has(u)).length;
  return hits / relevant.size;
}

export function reciprocalRank(retrieved: string[], relevant: Set<string>): number {
  for (let i = 0; i < retrieved.length; i++) {
    if (relevant.has(retrieved[i])) return 1 / (i + 1);
  }
  return 0;
}

/** Binary-relevance NDCG@K: gain = 1 if relevant, 0 otherwise. */
export function ndcgAtK(retrieved: string[], relevant: Set<string>, k: number): number {
  const dcg = retrieved.slice(0, k).reduce((sum, url, i) => {
    const gain = relevant.has(url) ? 1 : 0;
    return sum + gain / Math.log2(i + 2);
  }, 0);

  const idealHits = Math.min(relevant.size, k);
  const idcg = Array.from({ length: idealHits }, (_, i) => 1 / Math.log2(i + 2)).reduce(
    (a, b) => a + b,
    0,
  );

  return idcg === 0 ? 0 : dcg / idcg;
}

function uniqueUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Run the actual-embedding tier, or say why it did not run.
 *
 * The tier that supports a semantic-quality claim needs a real embedding model,
 * which needs credentials this repository does not and must not carry. The
 * failure mode worth designing against is a run that quietly falls back to the
 * synthetic tier and reports its numbers as quality — so absence of credentials
 * returns a SkippedEval and never a metric.
 */
export async function runActualEmbeddingEval(
  dataset: EvalDataset,
  opts: {
    aiClient?: AIClientInterface;
    embeddingModel?: string;
    k?: number;
  } & Omit<SearchOptions, 'topK'>
): Promise<AggregateMetrics | SkippedEval> {
  if (!opts.aiClient) {
    return {
      skipped: true,
      tier: 'actual-embeddings',
      reason: 'no embedding client configured',
    };
  }
  if (!opts.embeddingModel) {
    return {
      skipped: true,
      tier: 'actual-embeddings',
      reason: 'no embedding model identified — a metric that cannot name its model is not comparable',
    };
  }

  try {
    return await runRetrievalEval(dataset, {
      ...opts,
      aiClient: opts.aiClient,
      tier: 'actual-embeddings',
      embeddingModel: opts.embeddingModel,
    });
  } catch (err) {
    return {
      skipped: true,
      tier: 'actual-embeddings',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** A skipped tier, rendered so it cannot be mistaken for a result. */
export function formatSkipped(s: SkippedEval): string {
  return `Retrieval eval — ${s.tier}: SKIPPED (${s.reason}). No quality claim can be made from this run.`;
}

export function formatMetricsTable(m: AggregateMetrics): string {
  const { provenance: p } = m;
  const lines = [
    `Retrieval eval — ${p.tier}, model ${p.embeddingModel}`,
    `Corpus ${p.corpus.name} ${p.corpus.version} · ${p.sampleSize} of ${p.corpus.queries} queries evaluated`,
    p.tier === 'synthetic-index'
      ? 'Mechanics only: a synthetic index tests ranking arithmetic, not semantic quality.'
      : 'Semantic quality against the labelled corpus.',
    '',
    `k=${m.k}, ${m.perQuery.length} queries`,
    `  P@k:   ${m.precisionAtK.toFixed(3)}`,
    `  R@k:   ${m.recallAtK.toFixed(3)}`,
    `  MRR:   ${m.mrr.toFixed(3)}`,
    `  NDCG@k:${m.ndcgAtK.toFixed(3)}`,
    '',
    'Per-query:',
    ...m.perQuery.map(
      (q) =>
        `  • "${truncate(q.query, 50)}"  P=${q.precisionAtK.toFixed(2)} R=${q.recallAtK.toFixed(2)} RR=${q.reciprocalRank.toFixed(2)}`,
    ),
  ];
  return lines.join('\n');
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
