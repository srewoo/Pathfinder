import type { VectorRecord } from '../../storage/schemas';
import { vectorDB } from '../../storage/indexed-db';
import { createLogger } from '../../utils/logger';

const log = createLogger('vector-search');

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
  /**
   * When true, use AI to rerank top results by relevance to the query.
   * Adds one lightweight AI call. Significantly improves precision.
   * Requires aiClient to be provided.
   */
  useAIReranker?: boolean;
  /** AI client for reranking (required when useAIReranker is true). */
  aiClient?: import('../ai/ai-client').AIClientInterface;
}

// ── IVF-Flat Vector Index ──────────────────────────────────────────────────
// Partitions vectors into K clusters via mini-batch k-means. At search time,
// only the closest `nProbe` clusters are scanned instead of all vectors.
// Gives ~sqrt(N) speedup for large collections with minimal accuracy loss.

/** Number of k-means iterations during index build. */
const KMEANS_ITERATIONS = 8;
/** Number of clusters to probe during search (more = higher recall, slower). */
const DEFAULT_N_PROBE = 3;
/** Minimum vectors to bother with clustering (below this, linear scan is fine). */
const CLUSTER_THRESHOLD = 500;

interface VectorCluster {
  centroid: Float32Array;
  members: VectorRecord[];
}

class IVFIndex {
  private clusters: VectorCluster[] = [];
  private allRecords: VectorRecord[] = [];
  private dimensions = 0;

  get size(): number { return this.allRecords.length; }
  get clusterCount(): number { return this.clusters.length; }

  /** Build the index from a set of vector records. */
  build(records: VectorRecord[]): void {
    this.allRecords = records;
    if (records.length === 0) {
      this.clusters = [];
      return;
    }

    // Detect dimensions from first record
    this.dimensions = (records[0].embedding as number[] | Float32Array).length;

    // Don't cluster small datasets — linear scan is faster
    if (records.length < CLUSTER_THRESHOLD) {
      this.clusters = [{
        centroid: new Float32Array(this.dimensions),
        members: records,
      }];
      return;
    }

    const K = Math.max(4, Math.min(Math.ceil(Math.sqrt(records.length)), 64));
    this.clusters = this.kmeansCluster(records, K);
    log.debug(`IVF index built: ${records.length} vectors → ${this.clusters.length} clusters`);
  }

  /**
   * Search for nearest neighbors. Returns candidates from the closest `nProbe`
   * clusters, scored by cosine similarity.
   */
  search(
    queryEmbedding: number[],
    topK: number,
    minScore: number,
    nProbe = DEFAULT_N_PROBE,
    filterUrl?: string
  ): SearchResult[] {
    if (this.allRecords.length === 0) return [];

    // For small datasets or single cluster, scan all
    if (this.clusters.length <= 1) {
      return this.linearSearch(queryEmbedding, topK, minScore, filterUrl);
    }

    // Find closest clusters
    const clusterScores = this.clusters.map((cluster, idx) => ({
      idx,
      score: cosineSimilarityTyped(new Float32Array(queryEmbedding), cluster.centroid),
    }));
    clusterScores.sort((a, b) => b.score - a.score);

    const probeClusters = clusterScores.slice(0, Math.min(nProbe, this.clusters.length));

    // Scan only vectors in probed clusters
    const candidates: SearchResult[] = [];
    const halfMin = minScore * 0.5; // Pre-filter threshold

    for (const { idx } of probeClusters) {
      const cluster = this.clusters[idx];
      for (const record of cluster.members) {
        if (filterUrl && record.url !== filterUrl) continue;

        const score = cosineSimilarity(queryEmbedding, record.embedding as number[] | Float32Array);
        if (score >= halfMin) {
          candidates.push({ record, score });
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, topK * 3); // Return extra for MMR
  }

  /** Brute-force scan for small datasets or fallback. */
  private linearSearch(
    queryEmbedding: number[],
    topK: number,
    minScore: number,
    filterUrl?: string
  ): SearchResult[] {
    const halfMin = minScore * 0.5;
    const candidates: SearchResult[] = [];

    const records = filterUrl
      ? this.allRecords.filter((v) => v.url === filterUrl)
      : this.allRecords;

    for (const record of records) {
      const score = cosineSimilarity(queryEmbedding, record.embedding as number[] | Float32Array);
      if (score >= halfMin) {
        candidates.push({ record, score });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, topK * 3);
  }

  /** Mini-batch k-means clustering. */
  private kmeansCluster(records: VectorRecord[], K: number): VectorCluster[] {
    const dim = this.dimensions;

    // Initialize centroids with k-means++ seeding
    const centroids = this.kmeansppInit(records, K, dim);

    // Assignment array: which cluster each vector belongs to
    const assignments = new Int32Array(records.length);

    for (let iter = 0; iter < KMEANS_ITERATIONS; iter++) {
      // Assign each record to closest centroid
      for (let i = 0; i < records.length; i++) {
        const emb = records[i].embedding as number[] | Float32Array;
        let bestDist = -Infinity;
        let bestK = 0;
        for (let k = 0; k < K; k++) {
          const sim = cosineSimilarityTyped(
            emb instanceof Float32Array ? emb : new Float32Array(emb),
            centroids[k]
          );
          if (sim > bestDist) {
            bestDist = sim;
            bestK = k;
          }
        }
        assignments[i] = bestK;
      }

      // Recompute centroids as mean of assigned vectors
      const counts = new Int32Array(K);
      const sums = centroids.map(() => new Float64Array(dim));

      for (let i = 0; i < records.length; i++) {
        const k = assignments[i];
        const emb = records[i].embedding as number[] | Float32Array;
        counts[k]++;
        for (let d = 0; d < dim; d++) {
          sums[k][d] += emb[d];
        }
      }

      for (let k = 0; k < K; k++) {
        if (counts[k] === 0) continue;
        for (let d = 0; d < dim; d++) {
          centroids[k][d] = sums[k][d] / counts[k];
        }
        // L2-normalize centroid for cosine similarity
        normalizef32(centroids[k]);
      }
    }

    // Build cluster objects
    const clusterMembers: VectorRecord[][] = Array.from({ length: K }, () => []);
    for (let i = 0; i < records.length; i++) {
      clusterMembers[assignments[i]].push(records[i]);
    }

    return centroids
      .map((centroid, k) => ({ centroid, members: clusterMembers[k] }))
      .filter((c) => c.members.length > 0);
  }

  /** K-means++ initialization for better centroid seeding. */
  private kmeansppInit(records: VectorRecord[], K: number, _dim: number): Float32Array[] {
    const centroids: Float32Array[] = [];

    // Pick first centroid randomly
    const first = records[Math.floor(Math.random() * records.length)];
    const firstEmb = first.embedding as number[] | Float32Array;
    centroids.push(new Float32Array(firstEmb));

    // Pick remaining centroids proportional to distance from nearest existing centroid
    const distances = new Float64Array(records.length).fill(Infinity);

    for (let c = 1; c < K; c++) {
      // Update distances to nearest centroid
      const lastCentroid = centroids[c - 1];
      for (let i = 0; i < records.length; i++) {
        const emb = records[i].embedding as number[] | Float32Array;
        const sim = cosineSimilarityTyped(
          emb instanceof Float32Array ? emb : new Float32Array(emb),
          lastCentroid
        );
        const dist = 1 - sim; // Convert similarity to distance
        if (dist < distances[i]) distances[i] = dist;
      }

      // Weighted random selection
      let totalDist = 0;
      for (let i = 0; i < distances.length; i++) totalDist += distances[i];
      if (totalDist === 0) break;

      let target = Math.random() * totalDist;
      let chosen = 0;
      for (let i = 0; i < distances.length; i++) {
        target -= distances[i];
        if (target <= 0) { chosen = i; break; }
      }

      const chosenEmb = records[chosen].embedding as number[] | Float32Array;
      centroids.push(new Float32Array(chosenEmb));
    }

    return centroids;
  }
}

/** L2-normalize a Float32Array in place. */
function normalizef32(v: Float32Array): void {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
}

// ── Singleton index instance ────────────────────────────────────────────────
let vectorIndex: IVFIndex | null = null;
let indexDimensions = 0;

export function invalidateVectorCache(): void {
  vectorIndex = null;
  indexDimensions = 0;
}

async function getIndex(): Promise<IVFIndex> {
  // Validate cached index against actual DB state to detect external clears.
  // This is lightweight (single IDB count request) and prevents stale results.
  if (vectorIndex) {
    const dbCount = await vectorDB.count();
    if (dbCount !== vectorIndex.size) {
      log.debug(`Index stale (cached=${vectorIndex.size}, db=${dbCount}) — rebuilding`);
      vectorIndex = null;
    } else {
      return vectorIndex;
    }
  }

  const allVectors = await vectorDB.getAll();
  vectorIndex = new IVFIndex();
  vectorIndex.build(allVectors);

  if (allVectors.length > 0) {
    indexDimensions = (allVectors[0].embedding as number[] | Float32Array).length;
  }

  log.info(`Vector index loaded: ${vectorIndex.size} vectors, ${vectorIndex.clusterCount} clusters`);
  return vectorIndex;
}

// ── Cosine similarity ────────────────────────────────────────────────────────
function cosineSimilarity(a: number[] | Float32Array, b: number[] | Float32Array): number {
  if (a.length !== b.length) {
    const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
    if (ratio < 0.9) return 0;
  }
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

/** Optimized cosine similarity for Float32Array inputs. */
function cosineSimilarityTyped(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  // Process in chunks of 4 for better CPU pipelining
  const end4 = len - (len % 4);
  for (let i = 0; i < end4; i += 4) {
    dot += a[i] * b[i] + a[i + 1] * b[i + 1] + a[i + 2] * b[i + 2] + a[i + 3] * b[i + 3];
    normA += a[i] * a[i] + a[i + 1] * a[i + 1] + a[i + 2] * a[i + 2] + a[i + 3] * a[i + 3];
    normB += b[i] * b[i] + b[i + 1] * b[i + 1] + b[i + 2] * b[i + 2] + b[i + 3] * b[i + 3];
  }
  for (let i = end4; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

// ── BM25 keyword scoring ──────────────────────────────────────────────────────
const BM25_K1 = 1.5;
const BM25_B = 0.75;

/** Common English stopwords to exclude from BM25 scoring. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'it', 'as', 'was', 'are', 'be',
  'this', 'that', 'which', 'not', 'can', 'will', 'do', 'has', 'have',
  'had', 'been', 'if', 'its', 'all', 'no', 'so', 'we', 'my', 'he',
  'she', 'you', 'your', 'their', 'our', 'up', 'out', 'may',
]);

function tokenizeForKeyword(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => {
    if (w.length < 2) return false;
    if (STOPWORDS.has(w)) return false;
    // Keep numbers that are 2+ digits
    if (/^\d+$/.test(w)) return w.length >= 2;
    return true;
  });
}

function computeIDF(queryTokens: string[], docContents: string[]): Map<string, number> {
  const N = docContents.length;
  const idf = new Map<string, number>();

  // Pre-lowercase docs once for all tokens
  const lowerDocs = docContents.map((d) => d.toLowerCase());

  for (const token of queryTokens) {
    let df = 0;
    for (const doc of lowerDocs) {
      if (doc.includes(token)) df++;
    }
    idf.set(token, Math.log((N - df + 0.5) / (df + 0.5) + 1));
  }
  return idf;
}

function computeAvgDocLen(docContents: string[]): number {
  if (docContents.length === 0) return 0;
  const total = docContents.reduce((sum, d) => sum + tokenizeForKeyword(d).length, 0);
  return total / docContents.length;
}

function bm25Score(
  queryTokens: string[],
  docContent: string,
  idf: Map<string, number>,
  avgDocLen: number
): number {
  if (queryTokens.length === 0) return 0;
  const docTokens = tokenizeForKeyword(docContent);
  const docLen = docTokens.length;
  if (docLen === 0) return 0;

  const termFreq = new Map<string, number>();
  for (const t of docTokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);

  let score = 0;
  for (const token of queryTokens) {
    const tf = termFreq.get(token) ?? 0;
    if (tf === 0) continue;
    const idfVal = idf.get(token) ?? 0;
    const numerator = tf * (BM25_K1 + 1);
    const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * docLen / Math.max(avgDocLen, 1));
    score += idfVal * (numerator / denominator);
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

  // Validate query dimensions against index
  if (indexDimensions > 0 && queryEmbedding.length !== indexDimensions) {
    const ratio = Math.min(queryEmbedding.length, indexDimensions) / Math.max(queryEmbedding.length, indexDimensions);
    if (ratio < 0.9) {
      log.warn(`Embedding dimension mismatch: query=${queryEmbedding.length}, index=${indexDimensions}. Results may be unreliable. Re-crawl with consistent embedding model.`);
      return [];
    }
  }

  const index = await getIndex();
  if (index.size === 0) return [];

  // Use IVF index for candidate retrieval
  const candidates = index.search(queryEmbedding, topK, minScore, DEFAULT_N_PROBE, filterUrl);
  if (candidates.length === 0) return [];

  // Normalize and weight scores
  const normalizedCosine = normalizeScores(candidates.map((c) => c.score));
  const scored: SearchResult[] = candidates.map((c, i) => ({
    record: c.record,
    score: semanticWeight * normalizedCosine[i],
  }));

  scored.sort((a, b) => b.score - a.score);

  const filtered = scored
    .filter((r) => r.score >= minScore * semanticWeight)
    .slice(0, topK * 3);

  if (filtered.length === 0) return [];

  const lambda = 1 - diversityFactor;
  return mmrRerank(filtered, topK, lambda);
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

  const index = await getIndex();
  if (index.size === 0) return [];

  // Get vector candidates from IVF index
  const vectorCandidates = index.search(embedding, topK * 5, options.minScore ?? 0.25, DEFAULT_N_PROBE, filterUrl);
  if (vectorCandidates.length === 0) return [];

  // Compute BM25 scores only for candidate vectors (not entire corpus)
  const queryTokens = tokenizeForKeyword(queryText);
  const candidateContents = vectorCandidates.map((c) => c.record.content);
  const idf = computeIDF(queryTokens, candidateContents);
  const avgDocLen = computeAvgDocLen(candidateContents);

  const cosineScores = vectorCandidates.map((c) => c.score);
  const kwScores = vectorCandidates.map((c) =>
    bm25Score(queryTokens, c.record.content, idf, avgDocLen)
  );

  const normalizedCosine = normalizeScores(cosineScores);
  const normalizedKw = normalizeScores(kwScores);

  const minScore = options.minScore ?? 0.25;

  const scored: SearchResult[] = vectorCandidates
    .map((c, i) => ({
      record: c.record,
      score: semanticWeight * normalizedCosine[i] + keywordWeight * normalizedKw[i],
    }))
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK * 3);

  if (scored.length === 0) return [];

  const lambda = 1 - diversityFactor;
  const mmrResults = mmrRerank(scored, topK, lambda);

  if (useAIReranker && aiClient && mmrResults.length > 1) {
    return aiRerank(queryText, mmrResults, aiClient, topK);
  }

  return mmrResults;
}

// ── AI Relevance Reranker ─────────────────────────────────────────────────────
async function aiRerank(
  query: string,
  candidates: SearchResult[],
  aiClient: import('../ai/ai-client').AIClientInterface,
  topK: number
): Promise<SearchResult[]> {
  const pool = candidates.slice(0, Math.min(candidates.length, topK * 2));
  const listText = pool
    .map((r, i) => `[${i}] ${r.record.content.slice(0, 300)}`)
    .join('\n\n');

  let raw: string;
  try {
    const sanitizedQuery = query.replace(/[\n\r]/g, ' ').replace(/["""]/g, "'").slice(0, 500);
    raw = await aiClient.chat(
      [{
        role: 'user',
        content: `Query: "${sanitizedQuery}"\n\nScore each passage 0-10 for relevance. Return JSON only: {"scores": [n, n, ...]}\n\n${listText}`,
      }],
      { temperature: 0, jsonMode: true, maxTokens: 200 }
    );
  } catch {
    return candidates.slice(0, topK);
  }

  try {
    const parsed = JSON.parse(raw.replace(/```json\n?|\n?```/g, '').trim()) as { scores?: number[] };
    const scores = parsed.scores ?? [];
    return pool
      .map((r, i) => ({ ...r, score: r.score * 0.4 + ((scores[i] ?? 5) / 10) * 0.6 }))
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
