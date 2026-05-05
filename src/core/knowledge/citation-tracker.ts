/**
 * Track which knowledge-base documents were used during test planning.
 *
 * The retriever returns top-K chunks; the planner consumes them via the
 * prompt. Without explicit tracking we lose the link from a generated step
 * back to its source — making "why did the AI suggest this selector?"
 * hard to answer. Citation IDs solve that.
 */

import type { SearchResult } from './vector-search';

export interface Citation {
  /** Stable ID, e.g. "doc-1", "doc-2" — appears in formatted prompt context. */
  id: string;
  url: string;
  section: string;
  /** Score used for ranking; useful for debugging retrieval. */
  score: number;
  /** First 200 chars of the chunk text — survives prompt compression. */
  excerpt: string;
}

export function buildCitations(results: SearchResult[]): Citation[] {
  return results.map((r, i) => ({
    id: `doc-${i + 1}`,
    url: r.record.url,
    section: r.record.metadata.section || 'General',
    score: r.score,
    excerpt: truncate(r.record.content, 200),
  }));
}

/**
 * Format search results with citation IDs prominently. The model is asked to
 * reference these IDs (e.g. "[doc-1]") when its plan step is grounded in a
 * specific document — those references can later be parsed back out.
 */
export function formatCitedResults(results: SearchResult[]): {
  text: string;
  citations: Citation[];
} {
  const citations = buildCitations(results);
  if (citations.length === 0) {
    return { text: 'No relevant documentation found.', citations: [] };
  }
  const text = citations
    .map(
      (c, i) =>
        `[${c.id}] (${c.url} — ${c.section})\n${results[i].record.content}`,
    )
    .join('\n\n---\n\n');
  return { text, citations };
}

/**
 * Pull citation references out of generated text. Looks for [doc-1], [doc-2]
 * patterns and returns the unique IDs in order of first appearance.
 */
export function extractCitedIds(generatedText: string): string[] {
  const matches = generatedText.matchAll(/\[(doc-\d+)\]/g);
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const m of matches) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      ordered.push(m[1]);
    }
  }
  return ordered;
}

/**
 * Resolve cited IDs back to full Citation records. IDs not found in the
 * provided citation list are silently dropped (likely model hallucinations).
 */
export function resolveCitedIds(citedIds: string[], available: Citation[]): Citation[] {
  const byId = new Map(available.map((c) => [c.id, c]));
  return citedIds.map((id) => byId.get(id)).filter((c): c is Citation => !!c);
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
