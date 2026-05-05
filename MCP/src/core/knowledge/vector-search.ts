import type { VectorRecord } from '../../storage/schemas.js';
import { vectorRepo } from '../../storage/repositories/vector-repo.js';

export interface SearchResult {
  record: VectorRecord;
  score: number;
}

export interface SearchOptions {
  topK?: number;
  minScore?: number;
  filterUrl?: string;
  /** Weight for semantic (cosine) score. Default 0.7. */
  semanticWeight?: number;
  /** Weight for keyword (BM25) score. Default 0.3. */
  keywordWeight?: number;
  /** MMR diversity factor (0 = pure relevance, 1 = pure diversity). Default 0.3. */
  diversityFactor?: number;
  /** When true, call AI to re-score top results by relevance after MMR. Requires aiClient. */
  useAIReranker?: boolean;
  /** AI client for optional AI reranking. */
  aiClient?: import('../ai/ai-client.js').AIClientInterface;
}

// ── In-memory cache ──────────────────────────────────────────────────────────
let cachedVectors: VectorRecord[] | null = null;

export function invalidateVectorCache(): void {
  cachedVectors = null;
}

async function getAllVectors(): Promise<VectorRecord[]> {
  if (cachedVectors) return cachedVectors;
  cachedVectors = await vectorRepo.getAll();
  return cachedVectors;
}

// ── Cosine similarity ────────────────────────────────────────────────────────
function cosineSimilarity(a: number[] | Float32Array, b: number[] | Float32Array): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dot / denominator;
}

// ── BM25 keyword scoring with Robertson IDF ──────────────────────────────────
const BM25_K1 = 1.5;
const BM25_B = 0.75;

function tokenizeForKeyword(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
}

function computeIDF(queryTokens: string[], docContents: string[]): Map<string, number> {
  const N = docContents.length;
  const idf = new Map<string, number>();
  const uniqueTokens = new Set(queryTokens);
  for (const term of uniqueTokens) {
    const df = docContents.filter((d) => d.toLowerCase().includes(term)).length;
    idf.set(term, Math.log((N - df + 0.5) / (df + 0.5) + 1));
  }
  return idf;
}

function computeAvgDocLen(docContents: string[]): number {
  if (docContents.length === 0) return 0;
  const total = docContents.reduce((sum, d) => sum + tokenizeForKeyword(d).length, 0);
  return total / docContents.length;
}

function bm25Score(queryTokens: string[], docContent: string, idf: Map<string, number>, avgDocLen: number): number {
  if (queryTokens.length === 0) return 0;
  const docTokens = tokenizeForKeyword(docContent);
  const docLen = docTokens.length;
  if (docLen === 0) return 0;

  const docFreq = new Map<string, number>();
  for (const token of docTokens) {
    docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
  }

  let score = 0;
  for (const term of queryTokens) {
    const tf = docFreq.get(term) ?? 0;
    if (tf === 0) continue;
    const termIDF = idf.get(term) ?? 0;
    const numerator = tf * (BM25_K1 + 1);
    const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / avgDocLen));
    score += termIDF * (numerator / denominator);
  }
  return score;
}

function normalizeScores(scores: number[]): number[] {
  if (scores.length === 0) return [];
  const max = Math.max(...scores);
  if (max === 0) return scores.map(() => 0);
  return scores.map((s) => s / max);
}

// ── MMR (Maximal Marginal Relevance) ─────────────────────────────────────────
function mmrRerank(
  candidates: SearchResult[],
  topK: number,
  lambda: number
): SearchResult[] {
  if (candidates.length <= topK) return candidates;

  const selected: SearchResult[] = [];
  const remaining = [...candidates];

  selected.push(remaining.shift()!);

  while (selected.length < topK && remaining.length > 0) {
    let bestIdx = 0;
    let bestMmrScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const relevance = remaining[i].score;

      let maxSimilarity = 0;
      for (const sel of selected) {
        const sim = contentOverlap(remaining[i].record.content, sel.record.content);
        if (sim > maxSimilarity) maxSimilarity = sim;
      }

      const mmrScore = lambda * relevance - (1 - lambda) * maxSimilarity;
      if (mmrScore > bestMmrScore) {
        bestMmrScore = mmrScore;
        bestIdx = i;
      }
    }

    selected.push(remaining.splice(bestIdx, 1)[0]);
  }

  return selected;
}

function contentOverlap(a: string, b: string): number {
  const wordsA = new Set(tokenizeForKeyword(a));
  const wordsB = new Set(tokenizeForKeyword(b));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  return intersection / Math.min(wordsA.size, wordsB.size);
}

// ── Main search functions ────────────────────────────────────────────────────
export async function search(
  queryEmbedding: number[],
  topK = 3,
  minScore = 0.25,
  options: Omit<SearchOptions, 'topK' | 'minScore'> = {}
): Promise<SearchResult[]> {
  const {
    filterUrl,
    semanticWeight = 0.7,
    diversityFactor = 0.3,
  } = options;

  let allVectors = await getAllVectors();
  if (allVectors.length === 0) return [];

  if (filterUrl) {
    allVectors = allVectors.filter((v) => v.url === filterUrl);
    if (allVectors.length === 0) return [];
  }

  const cosineScores = allVectors.map((record) =>
    cosineSimilarity(queryEmbedding, record.embedding as number[] | Float32Array)
  );

  const candidateIndices = cosineScores
    .map((score, idx) => ({ score, idx }))
    .filter((c) => c.score >= minScore * 0.5)
    .map((c) => c.idx);

  if (candidateIndices.length === 0) return [];

  const normalizedCosine = normalizeScores(candidateIndices.map((i) => cosineScores[i]));

  const scored: SearchResult[] = candidateIndices.map((idx, i) => ({
    record: allVectors[idx],
    score: semanticWeight * normalizedCosine[i],
  }));

  scored.sort((a, b) => b.score - a.score);

  const candidates = scored
    .filter((r) => r.score >= minScore * semanticWeight)
    .slice(0, topK * 3);

  if (candidates.length === 0) return [];

  const lambda = 1 - diversityFactor;
  return mmrRerank(candidates, topK, lambda);
}

export async function searchByText(
  queryText: string,
  aiEmbed: (texts: string[]) => Promise<number[][]>,
  topK = 3,
  options: Omit<SearchOptions, 'topK'> = {}
): Promise<SearchResult[]> {
  const [embedding] = await aiEmbed([queryText]);
  if (!embedding) return [];

  const {
    keywordWeight = 0.3,
    semanticWeight = 0.7,
    filterUrl,
    diversityFactor = 0.3,
    useAIReranker = false,
    aiClient,
  } = options;

  let allVectors = await getAllVectors();
  if (allVectors.length === 0) return [];

  if (filterUrl) {
    allVectors = allVectors.filter((v) => v.url === filterUrl);
    if (allVectors.length === 0) return [];
  }

  const queryTokens = tokenizeForKeyword(queryText);
  const docContents = allVectors.map((v) => v.content);

  // Proper BM25 with IDF
  const idf = computeIDF(queryTokens, docContents);
  const avgDocLen = computeAvgDocLen(docContents);

  const cosineScores = allVectors.map((record) =>
    cosineSimilarity(embedding, record.embedding as number[] | Float32Array)
  );
  const kwScores = allVectors.map((record) =>
    bm25Score(queryTokens, record.content, idf, avgDocLen)
  );

  const normalizedCosine = normalizeScores(cosineScores);
  const normalizedKw = normalizeScores(kwScores);

  const minScore = options.minScore ?? 0.25;

  const scored: SearchResult[] = allVectors
    .map((record, i) => ({
      record,
      score: semanticWeight * normalizedCosine[i] + keywordWeight * normalizedKw[i],
    }))
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK * 3);

  if (scored.length === 0) return [];

  // MMR reranking for diversity
  const lambda = 1 - diversityFactor;
  const mmrResults = mmrRerank(scored, topK, lambda);

  // Optional AI reranker for precision
  if (useAIReranker && aiClient && mmrResults.length > 1) {
    return aiRerank(queryText, mmrResults, aiClient, topK);
  }

  return mmrResults;
}

// ── AI Relevance Reranker ─────────────────────────────────────────────────────
async function aiRerank(
  query: string,
  candidates: SearchResult[],
  aiClient: import('../ai/ai-client.js').AIClientInterface,
  topK: number
): Promise<SearchResult[]> {
  const snippets = candidates.map((r, i) => {
    const preview = r.record.content.slice(0, 200).replace(/\n/g, ' ');
    return `[${i}] ${preview}`;
  }).join('\n');

  let raw: string;
  try {
    raw = await aiClient.chat(
      [{
        role: 'user',
        content: `Query: "${query}"\n\nRate each chunk's relevance (0-10):\n${snippets}\n\nReturn JSON: {"scores": [<score for [0]>, <score for [1]>, ...]}`,
      }],
      { temperature: 0, jsonMode: true, maxTokens: 200 }
    );
  } catch {
    return candidates.slice(0, topK);
  }

  try {
    const parsed = JSON.parse(raw.replace(/```json\n?|\n?```/g, '').trim()) as { scores?: number[] };
    const scores = parsed.scores ?? [];
    return candidates
      .map((r, i) => ({
        record: r.record,
        score: 0.4 * r.score + 0.6 * ((scores[i] ?? 0) / 10),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  } catch {
    return candidates.slice(0, topK);
  }
}

export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return 'No relevant documentation found.';

  return results
    .map((r, i) => {
      const meta = r.record.metadata;
      return `[${i + 1}] Source: ${r.record.url}\nSection: ${meta.section || 'General'}\n\n${r.record.content}`;
    })
    .join('\n\n---\n\n');
}
