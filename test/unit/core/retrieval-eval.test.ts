import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  precisionAtK, recallAtK, reciprocalRank, ndcgAtK,
  runRetrievalEval, formatMetricsTable,
} from '../../../src/core/knowledge/retrieval-eval';

vi.mock('../../../src/core/knowledge/vector-search', () => ({
  searchByText: vi.fn(),
}));

const { searchByText } = await import('../../../src/core/knowledge/vector-search');

const ai = { chat: vi.fn(), embed: vi.fn() };

beforeEach(() => vi.clearAllMocks());

describe('precisionAtK', () => {
  it('given all retrieved relevant when computing then 1.0', () => {
    expect(precisionAtK(['a', 'b'], new Set(['a', 'b']), 5)).toBe(1);
  });
  it('given half relevant when computing then 0.5', () => {
    expect(precisionAtK(['a', 'b'], new Set(['a']), 2)).toBe(0.5);
  });
  it('given empty retrieved when computing then 0', () => {
    expect(precisionAtK([], new Set(['a']), 5)).toBe(0);
  });
  it('given k=0 when computing then 0', () => {
    expect(precisionAtK(['a'], new Set(['a']), 0)).toBe(0);
  });
});

describe('recallAtK', () => {
  it('given all relevant retrieved when computing then 1.0', () => {
    expect(recallAtK(['a', 'b'], new Set(['a', 'b']))).toBe(1);
  });
  it('given empty relevant when computing then 0', () => {
    expect(recallAtK(['a'], new Set())).toBe(0);
  });
});

describe('reciprocalRank', () => {
  it('given first hit at position 1 when computing then 1.0', () => {
    expect(reciprocalRank(['a', 'b'], new Set(['a']))).toBe(1);
  });
  it('given first hit at position 3 when computing then 1/3', () => {
    expect(reciprocalRank(['x', 'y', 'a'], new Set(['a']))).toBeCloseTo(1 / 3);
  });
  it('given no hits when computing then 0', () => {
    expect(reciprocalRank(['x', 'y'], new Set(['a']))).toBe(0);
  });
});

describe('ndcgAtK', () => {
  it('given perfect ordering when computing then 1.0', () => {
    expect(ndcgAtK(['a', 'b'], new Set(['a', 'b']), 5)).toBeCloseTo(1);
  });
  it('given relevant after irrelevant when computing then less than 1', () => {
    const v = ndcgAtK(['x', 'a'], new Set(['a']), 5);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(1);
  });
  it('given empty relevant when computing then 0', () => {
    expect(ndcgAtK(['a'], new Set(), 5)).toBe(0);
  });
});

describe('runRetrievalEval', () => {
  it('given two queries when evaluating then computes aggregate metrics', async () => {
    vi.mocked(searchByText)
      .mockResolvedValueOnce([
        mockResult('docA'),
        mockResult('docB'),
      ] as never)
      .mockResolvedValueOnce([
        mockResult('docX'),
        mockResult('docY'),
      ] as never);

    const result = await runRetrievalEval(
      {
        name: 'test',
        queries: [
          { query: 'q1', relevantUrls: ['docA'] },
          { query: 'q2', relevantUrls: ['docY'] },
        ],
      },
      { aiClient: ai as never, k: 2 },
    );

    expect(result.k).toBe(2);
    expect(result.perQuery).toHaveLength(2);
    expect(result.mrr).toBeCloseTo((1 + 1 / 2) / 2);
    expect(result.recallAtK).toBe(1);
  });

  it('given zero matches when evaluating then mrr is 0', async () => {
    vi.mocked(searchByText).mockResolvedValue([mockResult('zzz')] as never);
    const result = await runRetrievalEval(
      { name: 't', queries: [{ query: 'q', relevantUrls: ['aaa'] }] },
      { aiClient: ai as never, k: 5 },
    );
    expect(result.mrr).toBe(0);
    expect(result.precisionAtK).toBe(0);
  });
});

describe('formatMetricsTable', () => {
  it('given metrics when formatting then includes headline metrics', () => {
    const out = formatMetricsTable({
      k: 5,
      precisionAtK: 0.8, recallAtK: 0.9, mrr: 0.85, ndcgAtK: 0.92,
      perQuery: [],
    });
    expect(out).toContain('P@k:');
    expect(out).toContain('MRR:');
    expect(out).toContain('NDCG');
  });
});

function mockResult(url: string) {
  return {
    score: 0.8,
    record: {
      id: url, url, chunkIndex: 0, content: 'c',
      embedding: new Float32Array([0.1]),
      metadata: { section: 's', title: 't' },
    },
  };
}
