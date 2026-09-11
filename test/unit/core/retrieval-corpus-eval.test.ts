/**
 * T07 item 5: a retrieval metric has to say what produced it.
 *
 * Two tiers share one code path, and they are worth entirely different things:
 *
 *   · `synthetic-index` — a hand-built index. Checks that ranking arithmetic
 *     and the metric functions are correct. Says NOTHING about whether a real
 *     model finds the right passage.
 *   · `actual-embeddings` — the real model over the labelled corpus. The only
 *     tier that supports a quality claim, and the only one that needs
 *     credentials.
 *
 * The failure this pins is the quiet one: a run without credentials falling
 * back to the synthetic tier and reporting its numbers as quality. Absence of
 * credentials must be reported as SKIPPED.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const searchByText = vi.fn();
vi.mock('../../../src/core/knowledge/vector-search', () => ({
  searchByText: (...args: unknown[]) => searchByText(...args),
}));

import {
  runRetrievalEval,
  runActualEmbeddingEval,
  formatMetricsTable,
  formatSkipped,
  type AggregateMetrics,
} from '../../../src/core/knowledge/retrieval-eval';
import { DATASET, CORPUS, QUERIES, CORPUS_VERSION } from '../../evaluation/retrieval-corpus';
import type { AIClientInterface } from '../../../src/core/ai/ai-client';

const ai = { embed: vi.fn(async () => [[0.1, 0.2]]), chat: vi.fn() } as unknown as AIClientInterface;

/** A synthetic index: each query resolves to whatever its labels say. */
function perfectRetrieval() {
  let call = 0;
  searchByText.mockImplementation(async () => {
    const q = DATASET.queries[call++ % DATASET.queries.length];
    return q.relevantUrls.map((url) => ({ score: 0.9, record: { id: url, url, content: '', metadata: {} } }));
  });
}

beforeEach(() => {
  searchByText.mockReset();
  perfectRetrieval();
});

describe('the labelled corpus is internally consistent', () => {
  const urls = new Set(CORPUS.map((d) => d.url));

  it('given every labelled url then it exists in the corpus', () => {
    const missing = QUERIES.flatMap((q) => q.relevantUrls).filter((u) => !urls.has(u));

    expect(missing).toEqual([]);
  });

  it('given every query then it carries at least one label', () => {
    expect(QUERIES.filter((q) => q.relevantUrls.length === 0)).toEqual([]);
  });

  // A label without a stated reason cannot be argued with, and an unarguable
  // label quietly becomes the definition of correct.
  it('given every query then its labels are justified', () => {
    expect(QUERIES.filter((q) => !q.rationale.trim())).toEqual([]);
  });

  // The split-answer query is what separates recall from precision. Losing it
  // would make the corpus unable to tell those apart.
  it('given the corpus then at least one query is answered across two pages', () => {
    expect(QUERIES.some((q) => q.relevantUrls.length > 1)).toBe(true);
  });

  it('given the corpus then it is versioned so metrics stay comparable', () => {
    expect(DATASET.version).toBe(CORPUS_VERSION);
  });
});

describe('a metric identifies its tier, model, corpus and sample size', () => {
  it('given a synthetic run then it is labelled as synthetic', async () => {
    const m = await runRetrievalEval(DATASET, {
      aiClient: ai,
      k: 5,
      tier: 'synthetic-index',
      embeddingModel: 'synthetic',
    });

    expect(m.provenance).toMatchObject({
      tier: 'synthetic-index',
      embeddingModel: 'synthetic',
      corpus: { name: 'product-docs', version: CORPUS_VERSION, queries: QUERIES.length },
      sampleSize: QUERIES.length,
    });
  });

  it('given a synthetic run then its report says the numbers are mechanics only', async () => {
    const m = await runRetrievalEval(DATASET, {
      aiClient: ai, k: 5, tier: 'synthetic-index', embeddingModel: 'synthetic',
    });

    expect(formatMetricsTable(m)).toMatch(/not semantic quality/i);
  });

  it('given an actual-embedding run then its report claims semantic quality', async () => {
    const m = (await runActualEmbeddingEval(DATASET, {
      aiClient: ai,
      embeddingModel: 'text-embedding-3-small',
      k: 5,
    })) as AggregateMetrics;

    expect(formatMetricsTable(m)).toMatch(/semantic quality/i);
    expect(formatMetricsTable(m)).toContain('text-embedding-3-small');
  });
});

describe('the model tier reports as skipped rather than as success', () => {
  // The exact prohibition: no credentials must never read as a pass.
  it('given no embedding client then the tier is skipped with a reason', async () => {
    const result = await runActualEmbeddingEval(DATASET, { embeddingModel: 'm', k: 5 });

    expect(result).toEqual({
      skipped: true,
      tier: 'actual-embeddings',
      reason: 'no embedding client configured',
    });
  });

  // A number that cannot name its model cannot be compared to another number.
  it('given no named model then the tier is skipped', async () => {
    const result = await runActualEmbeddingEval(DATASET, { aiClient: ai, k: 5 });

    expect(result).toMatchObject({ skipped: true, tier: 'actual-embeddings' });
  });

  it('given the embedder fails mid-run then the tier is skipped rather than partially scored', async () => {
    searchByText.mockRejectedValue(new Error('429 rate limited'));

    const result = await runActualEmbeddingEval(DATASET, {
      aiClient: ai,
      embeddingModel: 'text-embedding-3-small',
      k: 5,
    });

    expect(result).toMatchObject({ skipped: true, reason: '429 rate limited' });
  });

  it('given a skipped tier then its rendering cannot be mistaken for a result', async () => {
    const result = await runActualEmbeddingEval(DATASET, { embeddingModel: 'm', k: 5 });

    const rendered = formatSkipped(result as { skipped: true; tier: 'actual-embeddings'; reason: string });
    expect(rendered).toMatch(/SKIPPED/);
    expect(rendered).toMatch(/no quality claim/i);
  });
});

describe('the metrics still measure what they claim to', () => {
  it('given perfect retrieval on the labelled corpus then recall is 1', async () => {
    const m = await runRetrievalEval(DATASET, {
      aiClient: ai, k: 5, tier: 'synthetic-index', embeddingModel: 'synthetic',
    });

    expect(m.recallAtK).toBe(1);
  });

  it('given retrieval that returns an unrelated page then precision falls', async () => {
    searchByText.mockResolvedValue([
      { score: 0.9, record: { id: 'x', url: 'https://docs.example.test/changelog', content: '', metadata: {} } },
    ]);

    const m = await runRetrievalEval(DATASET, {
      aiClient: ai, k: 5, tier: 'synthetic-index', embeddingModel: 'synthetic',
    });

    expect(m.precisionAtK).toBe(0);
    expect(m.mrr).toBe(0);
  });
});
