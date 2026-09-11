/**
 * What this session actually cost.
 *
 * The tracker it reads from existed for a long time with **nothing calling it**:
 * `recordChatUsage` had no callers, so `estimateCost()` always returned 0 — and the
 * cost budget guard, which compares spend against a limit, could never fire however
 * low the limit was set. Providers now report their real usage, embeddings are
 * counted (they were ignored by the cost math entirely), and this formats it.
 *
 * Every number here is an ESTIMATE from published per-model prices, computed
 * locally. It is not a bill, and the report says so — a figure that looks
 * authoritative and is quietly wrong is worse than one that states its basis.
 */
import { costBreakdown, type CostBreakdown } from './token-tracker';
import { PRICING_SOURCES } from './model-pricing';

/** Session-scoped counters plus when the window started. */
export interface CostSessionMeta {
  /** ISO timestamp the counters were last reset. */
  startedAt?: string;
  /** Cost limit in USD, when the run set one. */
  limitUsd?: number;
}

const usd = (n: number): string => (n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`);
const num = (n: number): string => n.toLocaleString('en-US');

export function formatCostReport(meta: CostSessionMeta = {}, model?: string): string {
  const b: CostBreakdown = costBreakdown(model);
  const u = b.usage;
  const lines: string[] = ['# LLM Cost — this session', ''];

  if (u.requests === 0) {
    lines.push('No AI requests recorded yet.', '');
    lines.push(
      'Counters start empty and reset when the extension is reloaded. Generate tests, ' +
        'learn flows, or crawl with embeddings to see spend here.'
    );
    return lines.join('\n');
  }

  lines.push(`**Estimated total: ${usd(b.totalUsd)}** across ${num(u.requests)} request(s)`);
  if (meta.startedAt) lines.push(`Counting since ${new Date(meta.startedAt).toLocaleString()}.`);
  lines.push('');

  lines.push('## Breakdown', '');
  lines.push('| Item | Tokens | Est. cost |');
  lines.push('|---|---:|---:|');
  lines.push(`| Chat input | ${num(u.inputTokens)} | — |`);
  lines.push(`| Chat output | ${num(u.outputTokens)} | — |`);
  lines.push(`| **Chat subtotal** (${b.model || 'unknown model'}) | ${num(u.inputTokens + u.outputTokens)} | ${usd(b.chatUsd)} |`);
  if (u.embeddingTokens > 0) {
    lines.push(
      `| **Embeddings** (${b.embeddingModel || 'local — no API cost'}) | ${num(u.embeddingTokens)} | ${usd(b.embeddingUsd)} |`
    );
  }
  lines.push(`| **Total** | ${num(u.inputTokens + u.outputTokens + u.embeddingTokens)} | **${usd(b.totalUsd)}** |`);
  lines.push('');

  if (b.pricedAs) {
    // A rate borrowed from a neighbouring id is a weaker claim than a rate
    // published for this one, and the difference is invisible in the total.
    lines.push(
      `> No rate is published under **${b.model}** itself, so the chat subtotal uses the ` +
        `published rate for **${b.pricedAs}**.`,
      ''
    );
  }

  if (b.priceNote) {
    lines.push(`> Rate caveat for **${b.pricedAs ?? b.model}**: ${b.priceNote}`, '');
  }

  if (b.pricingUnknown) {
    // Stated, not hidden behind a zero.
    lines.push(
      `> ⚠️ No published price is on file for **${b.model || 'the model in use'}**, so the chat ` +
        `subtotal above is **$0.00 by absence of data, not because the calls were free**. ` +
        `Token counts are still accurate.`,
      ''
    );
  }

  if (meta.limitUsd !== undefined) {
    const pct = meta.limitUsd > 0 ? Math.round((b.totalUsd / meta.limitUsd) * 100) : 0;
    lines.push(`## Budget`, '', `${usd(b.totalUsd)} of ${usd(meta.limitUsd)} used (${pct}%).`, '');
  }

  if (u.embeddingTokens === 0) {
    lines.push(
      '_No embedding tokens recorded. Local embeddings are free and are not counted here._',
      ''
    );
  }

  lines.push('## How this is calculated', '');
  lines.push(
    '- Token counts come from each provider\'s own `usage` field on the response — not estimated from text length.',
    `- Prices are the standard per-model rates in \`model-pricing.ts\`, copied from ${PRICING_SOURCES.map((s) => `${s.provider} (${s.url}, read ${s.retrieved})`).join('; ')}. They are updated by hand and can lag a provider's pricing change.`,
    '- Standard rates only: prompt caching, batch and other discounts are multipliers on these numbers and are not applied here.',
    '- Cached responses and local embeddings cost nothing and add no tokens, so a cheap run genuinely reads as cheap.',
    '- Counters cover the current session and reset when the extension reloads.'
  );

  return lines.join('\n');
}
