/**
 * The bug these guard: a real session spent 182,366 tokens on `gpt-4.1-mini`
 * and the panel reported $0.0000, because the table had no GPT-4.1 entry and
 * the lookup was an exact match against ids the provider never returns.
 */
import { describe, it, expect } from 'vitest';
import { resolveModelPrice, MODEL_PRICES, PRICING_SOURCES } from '../../../src/core/ai/model-pricing';

describe('published rates are present for the models the catalogue offers', () => {
  it.each([
    ['gpt-4.1-mini', 0.4, 1.6],
    ['gpt-4.1', 2, 8],
    ['gpt-5-nano', 0.05, 0.4],
    ['claude-opus-5', 5, 25],
    // Previously priced at the retired $15/$75 Opus 4.1 rate.
    ['claude-opus-4-7', 5, 25],
    ['gemini-2.5-flash', 0.3, 2.5],
  ])('given_%s_then_the_published_rate_is_returned', (id, input, output) => {
    const resolved = resolveModelPrice(id);

    expect(resolved?.exact).toBe(true);
    expect(resolved?.price).toMatchObject({ input, output });
  });

  it('given_a_model_with_no_published_rate_then_nothing_is_returned', () => {
    expect(resolveModelPrice('some-new-model-2029')).toBeUndefined();
    expect(resolveModelPrice(undefined)).toBeUndefined();
    expect(resolveModelPrice('   ')).toBeUndefined();
  });
});

describe('ids as the provider actually returns them', () => {
  it('given_a_dated_openai_snapshot_then_it_prices_as_its_base_model', () => {
    const resolved = resolveModelPrice('gpt-4.1-mini-2025-04-14');

    expect(resolved).toMatchObject({ pricedAs: 'gpt-4.1-mini', exact: true });
  });

  it('given_a_dated_anthropic_snapshot_then_it_prices_as_its_base_model', () => {
    const resolved = resolveModelPrice('claude-haiku-4-5-20251001');

    expect(resolved?.price).toMatchObject({ input: 1, output: 5 });
    expect(resolved?.exact).toBe(true);
  });

  it('given_a_google_qualified_name_then_the_prefix_is_stripped', () => {
    expect(resolveModelPrice('models/gemini-2.5-pro')?.price.input).toBe(1.25);
  });

  it('given_a_moving_alias_then_it_prices_as_the_family', () => {
    expect(resolveModelPrice('gpt-5-chat-latest')?.pricedAs).toBe('gpt-5');
  });

  // A snapshot priced differently from its family must not collapse onto it.
  it('given_the_separately_priced_gpt_4o_snapshot_then_its_own_rate_wins', () => {
    expect(resolveModelPrice('gpt-4o-2024-05-13')?.price).toMatchObject({ input: 5, output: 15 });
    expect(resolveModelPrice('gpt-4o')?.price).toMatchObject({ input: 2.5, output: 10 });
  });
});

describe('a borrowed rate is reported as borrowed', () => {
  it('given_an_unlisted_variant_then_it_falls_back_to_the_longest_prefix', () => {
    const resolved = resolveModelPrice('gpt-4.1-mini-turbo-2027');

    expect(resolved).toMatchObject({ pricedAs: 'gpt-4.1-mini', exact: false });
  });

  // Without a `-` boundary the longest-prefix search would price gpt-4.1 as
  // gpt-4 — a wrong number that looks exactly like a right one.
  it('given_a_dotted_version_then_it_does_not_borrow_from_the_major_version', () => {
    expect(resolveModelPrice('gpt-5.9-quasar')).toBeUndefined();
  });
});

describe('every rate is traceable', () => {
  it('given_the_table_then_no_entry_carries_a_negative_or_absent_rate', () => {
    for (const [id, price] of Object.entries(MODEL_PRICES)) {
      expect(price.input, id).toBeGreaterThanOrEqual(0);
      expect(price.output, id).toBeGreaterThanOrEqual(0);
    }
  });

  it('given_the_sources_then_each_names_a_provider_page_and_a_retrieval_date', () => {
    expect(PRICING_SOURCES.length).toBeGreaterThanOrEqual(3);
    for (const source of PRICING_SOURCES) {
      expect(source.url).toMatch(/^https:\/\//);
      expect(source.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
