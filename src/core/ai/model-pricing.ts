/**
 * Published per-model prices, and how to find one for an arbitrary model id.
 *
 * Two separate problems live here, and the second is the one that made the
 * panel report `$0.0000` over 182,366 real tokens.
 *
 * **The table was stale and incomplete.** It carried no GPT-4.1 entry at all,
 * and priced Claude Opus 4.7 at the retired $15/$75 rather than its published
 * $5/$25. Every rate below is now copied from the provider's own pricing page,
 * with the page and the retrieval date recorded in `PRICING_SOURCES` so the
 * next person can re-check rather than re-derive.
 *
 * **Exact-match lookup cannot work here.** The model dropdown is populated by
 * `model-catalog.ts` from the provider's own `/models` endpoint, which returns
 * dated snapshots (`gpt-4.1-mini-2025-04-14`, `claude-opus-4-5-20251101`) and
 * aliases (`gpt-5-chat-latest`) that no hand-maintained table will ever list.
 * A miss is not free — it prints a total of $0.00 — so resolution normalises the
 * id and falls back to the longest published prefix, and says which entry it
 * used. A price derived from a neighbouring id is a different claim from a
 * price published for the id itself, and the report distinguishes them.
 */

export interface ModelPrice {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. Zero for embedding models. */
  output: number;
  /**
   * A caveat attached to the published figure — a promotional rate with an end
   * date, or a price that steps up above a context threshold. Surfaced in the
   * cost report, because an estimate computed from a conditional rate is only
   * honest if it names the condition.
   */
  note?: string;
}

/** Where each block of rates came from, and when it was read. */
export const PRICING_SOURCES = [
  { provider: 'OpenAI', url: 'https://developers.openai.com/api/docs/pricing', retrieved: '2026-09-11' },
  { provider: 'Anthropic', url: 'https://platform.claude.com/docs/en/about-claude/pricing', retrieved: '2026-09-11' },
  { provider: 'Google', url: 'https://ai.google.dev/gemini-api/docs/pricing', retrieved: '2026-09-11' },
] as const;

const OVER_200K = 'Published rate for prompts up to 200k tokens; longer prompts are billed higher.';
const PROMO_2026 = 'Promotional rate through 2026-12-31; $1.50/$7.50 per 1M thereafter.';

/**
 * Standard (non-batch, non-cached, global-routing) rates per 1M tokens.
 *
 * Deliberately only the standard rate: prompt caching, batch, fast mode and
 * US-pinned inference are all multipliers on these numbers, and Pathfinder's
 * providers use none of them. Pricing a cached read at the base rate would
 * overstate spend as confidently as the old table understated it.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  // ---- OpenAI --------------------------------------------------------------
  'gpt-6-astra': { input: 10, output: 50 },

  'gpt-5.6-sol': { input: 4, output: 20 },
  'gpt-5.6-terra': { input: 2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, output: 1.2 },

  'gpt-5.5': { input: 5, output: 30 },
  'gpt-5.5-pro': { input: 30, output: 180 },

  'gpt-5.4': { input: 2.5, output: 15 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, output: 1.25 },
  'gpt-5.4-pro': { input: 30, output: 180 },

  'gpt-5.2': { input: 1.75, output: 14 },
  'gpt-5.2-pro': { input: 21, output: 168 },
  'gpt-5.1': { input: 1.25, output: 10 },
  'gpt-5': { input: 1.25, output: 10 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  'gpt-5-nano': { input: 0.05, output: 0.4 },
  'gpt-5-pro': { input: 15, output: 120 },

  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },

  'gpt-4o': { input: 2.5, output: 10 },
  // Priced above the current gpt-4o rate, so it must survive date-stripping as
  // its own entry rather than collapsing onto the family.
  'gpt-4o-2024-05-13': { input: 5, output: 15 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },

  'o1': { input: 15, output: 60 },
  'o1-pro': { input: 150, output: 600 },
  'o3': { input: 2, output: 8 },
  'o3-pro': { input: 20, output: 80 },
  'o3-mini': { input: 1.1, output: 4.4 },
  'o4-mini': { input: 1.1, output: 4.4 },

  'text-embedding-3-small': { input: 0.02, output: 0 },
  'text-embedding-3-large': { input: 0.13, output: 0 },
  'text-embedding-ada-002': { input: 0.1, output: 0 },

  // ---- Anthropic -----------------------------------------------------------
  // API ids omit the dated suffix the catalogue returns; resolution strips it.
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5-1': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },

  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-opus-4-5': { input: 5, output: 25 },
  'claude-opus-4-1': { input: 15, output: 75 },
  'claude-opus-4': { input: 15, output: 75 },

  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-sonnet-4': { input: 3, output: 15 },

  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },

  // ---- Google --------------------------------------------------------------
  'gemini-3.8-flash': { input: 0.75, output: 3.75, note: PROMO_2026 },
  'gemini-3.7-flash': { input: 0.75, output: 3.75, note: PROMO_2026 },
  'gemini-3.6-flash': { input: 0.75, output: 3.75, note: PROMO_2026 },
  'gemini-3.5-flash': { input: 1.5, output: 9 },
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.5 },
  'gemini-3.1-pro-preview': { input: 2, output: 12, note: OVER_200K },
  'gemini-omni-1.1-flash': { input: 1.5, output: 9 },
  'gemini-2.5-pro': { input: 1.25, output: 10, note: OVER_200K },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },

  'gemini-embedding-2': { input: 0.2, output: 0 },
  'gemini-embedding-001': { input: 0.15, output: 0 },
};

export interface ResolvedPrice {
  price: ModelPrice;
  /** The table entry the figures came from. */
  pricedAs: string;
  /** False when the rate belongs to a related id rather than this one. */
  exact: boolean;
}

/** Trailing snapshot dates: `-20251101` and `-2025-04-14`. */
const DATE_SUFFIX = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/;
/** Moving aliases the providers publish alongside pinned ids. */
const ALIAS_SUFFIX = /-(?:latest|preview|exp)$/;

function normalise(id: string): string {
  let out = id.trim().toLowerCase().replace(/^models\//, '');
  out = out.replace(DATE_SUFFIX, '');
  out = out.replace(ALIAS_SUFFIX, '');
  return out;
}

/**
 * Find the published rate that applies to a model id.
 *
 * Tries the id verbatim, then the id with its snapshot date and alias suffix
 * removed, then the longest published id it extends on a `-` boundary. The
 * boundary matters: without it `gpt-4.1` would be priced as `gpt-4`, and a
 * silently mispriced total is worse than an admitted gap.
 *
 * Returns `undefined` rather than a zero when nothing matches, so the caller
 * can say so.
 */
export function resolveModelPrice(id: string | undefined): ResolvedPrice | undefined {
  if (!id) return undefined;

  const verbatim = MODEL_PRICES[id] ?? MODEL_PRICES[id.trim().toLowerCase()];
  if (verbatim) return { price: verbatim, pricedAs: id, exact: true };

  const key = normalise(id);
  if (!key) return undefined;
  const direct = MODEL_PRICES[key];
  if (direct) return { price: direct, pricedAs: key, exact: true };

  let best: string | undefined;
  for (const candidate of Object.keys(MODEL_PRICES)) {
    if (!key.startsWith(`${candidate}-`)) continue;
    if (!best || candidate.length > best.length) best = candidate;
  }
  if (!best) return undefined;
  return { price: MODEL_PRICES[best], pricedAs: best, exact: false };
}
