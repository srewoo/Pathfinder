/**
 * T07 items 1–4: the knowledge base has to be able to explain itself.
 *
 * The behaviour under test is not "does retrieval work" — the retrieval tests
 * cover that. It is that the DIFFERENT ways of returning nothing stay
 * distinguishable. Today every one of them arrives at the caller as an empty
 * array, and the user is left rewording a query against an index their model
 * cannot be compared with.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const searchByText = vi.fn();
const describeIndex = vi.fn();

vi.mock('../../../src/core/knowledge/vector-search', () => ({
  searchByText: (...args: unknown[]) => searchByText(...args),
  describeIndex: () => describeIndex(),
}));

import { queryKnowledge, explainOutcome, STALE_AFTER_DAYS } from '../../../src/core/knowledge/knowledge-query';
import type { AIClientInterface } from '../../../src/core/ai/ai-client';

const NOW = Date.parse('2026-09-11T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function client(embed: (texts: string[]) => Promise<number[][]>): AIClientInterface {
  return { embed, chat: vi.fn() } as unknown as AIClientInterface;
}

const okClient = client(async () => [[0.1, 0.2, 0.3]]);

function record(over: Record<string, unknown> = {}) {
  return {
    record: {
      id: 'v1',
      content: 'Declined cards show an inline retry prompt.',
      url: 'https://docs.test/checkout',
      metadata: {
        title: 'Checkout',
        section: 'Payments',
        breadcrumbPath: 'Docs > Checkout > Payments',
        crawledAt: new Date(NOW - DAY).toISOString(),
        chunkIndex: 2,
        totalChunks: 9,
        embeddingModel: 'text-embedding-3-small',
      },
      ...over,
    },
    score: 0.82,
  };
}

beforeEach(() => {
  searchByText.mockReset();
  describeIndex.mockReset();
  describeIndex.mockResolvedValue({
    vectors: 120,
    documents: 14,
    dimensions: 3,
    embeddingModels: ['text-embedding-3-small'],
    oldestCrawledAt: new Date(NOW - 5 * DAY).toISOString(),
    newestCrawledAt: new Date(NOW - DAY).toISOString(),
  });
  searchByText.mockResolvedValue([record()]);
});

describe('an empty result says which kind of empty it is', () => {
  it('given_nothing_is_indexed_then_the_outcome_is_empty_index', async () => {
    describeIndex.mockResolvedValue({
      vectors: 0, documents: 0, dimensions: 0, embeddingModels: [],
    });

    const result = await queryKnowledge('anything', okClient, { now: NOW });

    expect(result.outcome).toEqual({ kind: 'empty-index' });
    expect(searchByText).not.toHaveBeenCalled();
  });

  it('given_an_indexed_corpus_with_no_matches_then_the_outcome_is_no_match', async () => {
    searchByText.mockResolvedValue([]);

    const result = await queryKnowledge('something unrelated', okClient, { now: NOW });

    expect(result.outcome).toEqual({ kind: 'no-match' });
  });

  // The failure this whole module exists for: the search silently returns
  // nothing, and rewording the query can never fix it.
  it('given_the_query_embeds_at_a_different_dimension_then_the_mismatch_is_reported', async () => {
    const result = await queryKnowledge('q', client(async () => [[1, 2, 3, 4, 5]]), { now: NOW });

    expect(result.outcome).toEqual({
      kind: 'embedding-mismatch',
      queryDimensions: 5,
      indexDimensions: 3,
    });
  });

  it('given_a_mismatch_then_no_search_is_attempted', async () => {
    await queryKnowledge('q', client(async () => [[1, 2, 3, 4, 5]]), { now: NOW });

    expect(searchByText).not.toHaveBeenCalled();
  });

  it('given_embedding_throws_then_the_reason_is_reported_rather_than_swallowed', async () => {
    const failing = client(async () => {
      throw new Error('401 invalid api key');
    });

    const result = await queryKnowledge('q', failing, { now: NOW });

    expect(result.outcome).toEqual({ kind: 'unavailable', reason: '401 invalid api key' });
  });

  it('given_search_throws_then_the_query_still_returns_an_answer', async () => {
    searchByText.mockRejectedValue(new Error('index read failed'));

    const result = await queryKnowledge('q', okClient, { now: NOW });

    expect(result.outcome).toEqual({ kind: 'unavailable', reason: 'index read failed' });
    expect(result.passages).toEqual([]);
  });

  it('given_a_blank_query_then_nothing_is_embedded', async () => {
    const embed = vi.fn(async () => [[0.1, 0.2, 0.3]]);

    await queryKnowledge('   ', client(embed), { now: NOW });

    expect(embed).not.toHaveBeenCalled();
  });
});

describe('a passage carries everything needed to check it', () => {
  it('given_a_result_then_its_source_and_position_are_returned', async () => {
    const { passages } = await queryKnowledge('declined card', okClient, { now: NOW });

    expect(passages[0]).toMatchObject({
      id: 'v1',
      url: 'https://docs.test/checkout',
      title: 'Checkout',
      breadcrumbPath: 'Docs > Checkout > Payments',
      chunkIndex: 2,
      totalChunks: 9,
      rank: 1,
      rankingScore: 0.82,
      embeddingModel: 'text-embedding-3-small',
    });
  });

  it('given_a_result_then_the_indexed_text_itself_is_returned', async () => {
    const { passages } = await queryKnowledge('declined card', okClient, { now: NOW });

    // What generation actually saw. Without it, a citation cannot be checked.
    expect(passages[0].content).toBe('Declined cards show an inline retry prompt.');
  });

  it('given_several_results_then_ranks_are_one_based_and_in_order', async () => {
    searchByText.mockResolvedValue([record(), record({ id: 'v2' }), record({ id: 'v3' })]);

    const { passages } = await queryKnowledge('q', okClient, { now: NOW });

    expect(passages.map((p) => p.rank)).toEqual([1, 2, 3]);
  });
});

describe('staleness is reported, not assumed away', () => {
  it('given_a_passage_older_than_the_window_then_it_is_marked_stale', async () => {
    searchByText.mockResolvedValue([
      record({ metadata: { ...record().record.metadata, crawledAt: new Date(NOW - (STALE_AFTER_DAYS + 1) * DAY).toISOString() } }),
    ]);

    const result = await queryKnowledge('q', okClient, { now: NOW });

    expect(result.passages[0].stale).toBe(true);
    expect(result.stalePassages).toBe(1);
  });

  it('given_a_recently_crawled_passage_then_it_is_not_stale', async () => {
    const result = await queryKnowledge('q', okClient, { now: NOW });

    expect(result.passages[0].stale).toBe(false);
    expect(result.stalePassages).toBe(0);
  });

  it('given_a_passage_with_an_unparseable_date_then_it_is_not_claimed_stale', async () => {
    searchByText.mockResolvedValue([
      record({ metadata: { ...record().record.metadata, crawledAt: 'not a date' } }),
    ]);

    const result = await queryKnowledge('q', okClient, { now: NOW });

    expect(result.passages[0].stale).toBe(false);
  });
});

describe('the corpus is described alongside the answer', () => {
  it('given_any_query_then_the_index_state_travels_with_the_result', async () => {
    const result = await queryKnowledge('q', okClient, { now: NOW });

    expect(result.index).toMatchObject({ vectors: 120, documents: 14, dimensions: 3 });
  });

  // A corpus embedded with two models has scores that are not mutually
  // comparable, and the ranking is meaningless across the boundary.
  it('given_a_mixed_model_corpus_then_every_model_is_listed', async () => {
    describeIndex.mockResolvedValue({
      vectors: 10, documents: 2, dimensions: 3,
      embeddingModels: ['text-embedding-3-small', 'local-minilm'],
    });

    const result = await queryKnowledge('q', okClient, { now: NOW });

    expect(result.index.embeddingModels).toEqual(['text-embedding-3-small', 'local-minilm']);
  });
});

describe('every outcome has a sentence a user can act on', () => {
  it.each([
    ['empty-index', /crawl/i],
    ['no-match', /may not cover/i],
    ['embedding-mismatch', /re-crawl/i],
    ['unavailable', /could not run/i],
  ])('given_the_%s_outcome_then_the_explanation_names_the_fix', async (kind, pattern) => {
    if (kind === 'empty-index') {
      describeIndex.mockResolvedValue({ vectors: 0, documents: 0, dimensions: 0, embeddingModels: [] });
    }
    if (kind === 'no-match') searchByText.mockResolvedValue([]);
    const ai =
      kind === 'embedding-mismatch'
        ? client(async () => [[1, 2, 3, 4]])
        : kind === 'unavailable'
          ? client(async () => { throw new Error('no key'); })
          : okClient;

    const result = await queryKnowledge('q', ai, { now: NOW });

    expect(result.outcome.kind).toBe(kind);
    expect(explainOutcome(result)).toMatch(pattern);
  });

  it('given_results_then_the_explanation_counts_them_with_their_corpus', async () => {
    const result = await queryKnowledge('q', okClient, { now: NOW });

    expect(explainOutcome(result)).toBe('1 passage from 14 indexed documents.');
  });
});
