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
  queries: EvalQuery[];
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
}

export async function runRetrievalEval(
  dataset: EvalDataset,
  opts: RunEvalOptions,
): Promise<AggregateMetrics> {
  const k = opts.k ?? 5;
  const perQuery: QueryMetrics[] = [];

  for (const q of dataset.queries) {
    const results = await searchByText(q.query, opts.aiClient, { ...opts, topK: k });
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

export function formatMetricsTable(m: AggregateMetrics): string {
  const lines = [
    `Retrieval eval — k=${m.k}, ${m.perQuery.length} queries`,
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
