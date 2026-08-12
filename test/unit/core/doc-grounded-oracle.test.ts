/**
 * Doc-grounded oracle (fix.md §6, §8.0, §9).
 *
 * The property under test is the boundary, not the prose: the model converts
 * documentation into ASSERTIONS, which are validated and then evaluated
 * deterministically. It never returns a verdict, and it cannot speak when the
 * docs are silent — the two guards that stop a doc-grounded oracle from becoming
 * a confident false-positive engine.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const searchByText = vi.fn();
vi.mock('../../../src/core/knowledge/vector-search', () => ({
  searchByText: (...args: unknown[]) => searchByText(...args),
}));

const {
  deriveDocGroundedAssertions,
  formatExpectations,
  retrieveExpectations,
} = await import('../../../src/core/planner/doc-grounded-oracle');
const { diffState } = await import('../../../src/core/analysis/state-diff');

const emptySnapshot = {
  url: 'https://app.test/orders',
  title: 'Orders',
  dom: { text: '', textContentLength: 0, elementCount: 0, tagCounts: {}, fieldValues: {}, liveRegions: [] },
  storage: { local: {}, session: {} },
  networkCount: 0,
};

const diff = () => diffState(emptySnapshot, { ...emptySnapshot, networkCount: 0 }, []);

function aiClient(chatReply: string) {
  return {
    chat: vi.fn().mockResolvedValue(chatReply),
    embed: vi.fn().mockResolvedValue([[0.1, 0.2]]),
  };
}

function docHit(content: string, score = 0.8) {
  return {
    record: {
      id: 'v1',
      content,
      url: 'https://docs.app.test/orders',
      embedding: [0.1],
      metadata: {
        title: 'Creating orders',
        section: 'Orders',
        crawledAt: '',
        chunkIndex: 0,
        totalChunks: 1,
      },
    },
    score,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('retrieveExpectations', () => {
  it('given_a_relevant_doc_then_it_is_returned_with_its_citation', async () => {
    searchByText.mockResolvedValue([docHit('Saving an order calls POST /api/orders.')]);
    const out = await retrieveExpectations('Save order', 'https://app.test/orders', aiClient('{}') as never);
    expect(out).toHaveLength(1);
    expect(out[0].sourceTitle).toBe('Creating orders');
    expect(out[0].sourceUrl).toBe('https://docs.app.test/orders');
  });

  it('given_only_weak_matches_then_nothing_is_returned', async () => {
    // A weak match produces assertions about a different feature, which is worse
    // than producing none.
    searchByText.mockResolvedValue([docHit('Unrelated billing prose', 0.2)]);
    expect(
      await retrieveExpectations('Save order', 'https://app.test/', aiClient('{}') as never)
    ).toEqual([]);
  });

  it('given_retrieval_failure_then_it_degrades_to_empty_rather_than_throwing', async () => {
    searchByText.mockRejectedValue(new Error('index unavailable'));
    expect(
      await retrieveExpectations('Save order', 'https://app.test/', aiClient('{}') as never)
    ).toEqual([]);
  });
});

describe('the model cannot speak when the docs are silent', () => {
  it('given_no_matching_docs_then_no_assertions_and_the_model_is_never_called', async () => {
    // The single most important guard in this module.
    searchByText.mockResolvedValue([]);
    const ai = aiClient('{"assertions":[{"kind":"visible","description":"invented"}]}');

    const result = await deriveDocGroundedAssertions(
      { actionDescription: 'Save order', pageUrl: 'https://app.test/orders', diff: diff() },
      ai as never
    );

    expect(result.assertions).toEqual([]);
    expect(result.skipped).toMatch(/no documentation matched/);
    expect(ai.chat).not.toHaveBeenCalled();
  });
});

describe('assertions are validated, never trusted', () => {
  it('given_a_valid_documented_assertion_then_it_is_returned_and_labelled_doc_asserted', async () => {
    searchByText.mockResolvedValue([docHit('Saving an order calls POST /api/orders.')]);
    const ai = aiClient(
      JSON.stringify({
        assertions: [
          {
            kind: 'api_called',
            expected: 'POST /api/orders',
            description: 'Docs state saving an order calls POST /api/orders',
          },
        ],
      })
    );

    const result = await deriveDocGroundedAssertions(
      { actionDescription: 'Save order', pageUrl: 'https://app.test/orders', diff: diff() },
      ai as never
    );

    expect(result.assertions).toHaveLength(1);
    expect(result.assertions[0].kind).toBe('api_called');
    // The confidence tier exists to keep this distinguishable from a guess.
    expect(result.assertions[0].confidence).toBe('doc_asserted');
  });

  it('given_an_invented_assertion_kind_then_it_is_dropped_not_coerced', async () => {
    // A hallucinated kind must become a validation failure, not a silent default
    // that would then be evaluated as if the docs had asked for it.
    searchByText.mockResolvedValue([docHit('Saving an order calls POST /api/orders.')]);
    const ai = aiClient(
      JSON.stringify({
        assertions: [{ kind: 'telepathy', expected: 'x', description: 'made up' }],
      })
    );

    const result = await deriveDocGroundedAssertions(
      { actionDescription: 'Save order', pageUrl: 'https://app.test/orders', diff: diff() },
      ai as never
    );
    expect(result.assertions).toEqual([]);
  });

  it('given_one_bad_assertion_among_good_ones_then_only_the_bad_one_is_dropped', async () => {
    searchByText.mockResolvedValue([docHit('Saving shows the order number and calls the API.')]);
    const ai = aiClient(
      JSON.stringify({
        assertions: [
          { kind: 'api_called', expected: 'POST /api/orders', description: 'API is called' },
          { kind: 'nonsense', expected: 'x', description: 'bad' },
          { kind: 'text', expected: 'Order #', description: 'Order number is shown' },
        ],
      })
    );

    const result = await deriveDocGroundedAssertions(
      { actionDescription: 'Save order', pageUrl: 'https://app.test/orders', diff: diff() },
      ai as never
    );
    expect(result.assertions.map((a) => a.kind)).toEqual(['api_called', 'text']);
    // Orders stay contiguous so the IR remains well-formed.
    expect(result.assertions.map((a) => a.order)).toEqual([0, 1]);
  });

  it('given_an_assertion_with_no_description_then_it_is_dropped', async () => {
    // The IR requires a description; an unexplained assertion is unreviewable.
    searchByText.mockResolvedValue([docHit('Saving calls the API.')]);
    const ai = aiClient(JSON.stringify({ assertions: [{ kind: 'api_called', expected: 'POST /x' }] }));
    const result = await deriveDocGroundedAssertions(
      { actionDescription: 'Save', pageUrl: 'https://app.test/', diff: diff() },
      ai as never
    );
    expect(result.assertions).toEqual([]);
  });

  it('given_unparseable_output_then_it_degrades_with_a_reason', async () => {
    searchByText.mockResolvedValue([docHit('Saving calls the API.')]);
    const result = await deriveDocGroundedAssertions(
      { actionDescription: 'Save', pageUrl: 'https://app.test/', diff: diff() },
      aiClient('not json at all') as never
    );
    expect(result.assertions).toEqual([]);
    expect(result.skipped).toMatch(/unparseable/);
  });

  it('given_an_AI_failure_then_it_degrades_without_throwing', async () => {
    searchByText.mockResolvedValue([docHit('Saving calls the API.')]);
    const ai = { chat: vi.fn().mockRejectedValue(new Error('rate limit')), embed: vi.fn().mockResolvedValue([[0.1]]) };
    const result = await deriveDocGroundedAssertions(
      { actionDescription: 'Save', pageUrl: 'https://app.test/', diff: diff() },
      ai as never
    );
    expect(result.assertions).toEqual([]);
    expect(result.skipped).toMatch(/AI call failed/);
  });
});

describe('positional attachment', () => {
  it('given_an_afterStep_then_assertions_are_pinned_to_it', async () => {
    // Doc-grounded assertions describe the effect of a specific action, so they
    // must be checked there rather than at the end of the run (§6).
    searchByText.mockResolvedValue([docHit('Saving shows a confirmation.')]);
    const ai = aiClient(
      JSON.stringify({ assertions: [{ kind: 'text', expected: 'Saved', description: 'Confirmation shown' }] })
    );
    const result = await deriveDocGroundedAssertions(
      { actionDescription: 'Save', pageUrl: 'https://app.test/', diff: diff(), afterStep: 3 },
      ai as never
    );
    expect(result.assertions[0].afterStep).toBe(3);
  });
});

describe('formatExpectations', () => {
  it('given_assertions_then_the_citation_travels_with_them', async () => {
    searchByText.mockResolvedValue([docHit('Saving calls POST /api/orders.')]);
    const ai = aiClient(
      JSON.stringify({
        assertions: [{ kind: 'api_called', expected: 'POST /api/orders', description: 'Docs require the API call' }],
      })
    );
    const result = await deriveDocGroundedAssertions(
      { actionDescription: 'Save', pageUrl: 'https://app.test/', diff: diff() },
      ai as never
    );
    const text = formatExpectations(result);
    expect(text).toContain('Docs require the API call');
    expect(text).toContain('Creating orders');
    expect(text).toContain('https://docs.app.test/orders');
  });

  it('given_no_assertions_then_it_states_why', async () => {
    searchByText.mockResolvedValue([]);
    const result = await deriveDocGroundedAssertions(
      { actionDescription: 'Save', pageUrl: 'https://app.test/', diff: diff() },
      aiClient('{}') as never
    );
    expect(formatExpectations(result)).toMatch(/No doc-grounded assertions —/);
  });
});
