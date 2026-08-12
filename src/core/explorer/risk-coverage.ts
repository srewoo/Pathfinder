/**
 * Risk-weighted exploration coverage.
 *
 * The metric this replaces was self-referential: `mapped / (mapped + discovered)`.
 * It answered "how much of what I found did I visit", which is high by
 * construction when little is found — an explorer that discovers one page and
 * visits it scores 100%. It told you about the crawler, not the app.
 *
 * This weights pages by how much RISK they carry. A checkout form with required
 * fields and a POST endpoint is worth far more than an about page, so leaving it
 * unvisited should cost far more. The output names the specific high-risk areas
 * that were missed, which turns a percentage into a work list.
 *
 * Deterministic and zero-token: every input is something exploration observed.
 */
import type { InteractionGraph, PageNode } from '../../storage/schemas';

/** Contributions to a page's risk weight. Additive and deliberately legible. */
export const RISK_WEIGHTS = {
  /** Baseline: any page can break. */
  base: 1,
  /** A form means the user can change state here. */
  hasForm: 3,
  /** Per required field — required data is data the app depends on. */
  requiredField: 1,
  /** A field handling credentials or payment. The costliest place to be wrong. */
  sensitiveField: 4,
  /** An observed mutating endpoint: this page provably writes. */
  mutatingApi: 4,
  /** Multi-step flows fail in the middle. */
  wizard: 2,
  /** Per interactive element, capped — breadth of interaction surface. */
  perInteractive: 0.1,
  maxInteractive: 3,
  /** A page that only appears behind auth is usually the product proper. */
  authGated: 2,
} as const;

const SENSITIVE_PATTERN =
  /pass(word)?|card|cvv|cvc|iban|account|ssn|social|secret|token|routing|expiry|security[_-]?code/i;

export interface PageRisk {
  url: string;
  title: string;
  weight: number;
  /** Why this page scored what it did — makes the number auditable. */
  reasons: string[];
  /** True when exploration actually scanned it. */
  covered: boolean;
}

export interface RiskCoverage {
  /** Risk-weighted coverage, 0–1. */
  ratio: number;
  totalWeight: number;
  coveredWeight: number;
  /** Uncovered pages, heaviest first — the remediation order. */
  gaps: PageRisk[];
  /** Simple page count, kept for continuity with the old metric. */
  pagesCovered: number;
  pagesKnown: number;
  /** Uncovered pages carrying above-average risk. The headline number. */
  highRiskGaps: number;
}

/**
 * Weight a single page.
 *
 * Only observed facts contribute. A page whose forms were never scanned scores
 * its baseline — which is correct: an unexplored page's risk is *unknown*, and
 * inflating it would let the metric be gamed by discovering more links.
 */
export function riskOf(node: PageNode, opts: { authGated?: boolean } = {}): PageRisk {
  const reasons: string[] = [];
  let weight = RISK_WEIGHTS.base;

  const fields = node.formFields ?? [];
  if (fields.length > 0) {
    weight += RISK_WEIGHTS.hasForm;
    reasons.push(`form with ${fields.length} field(s)`);

    const required = fields.filter((f) => f.required).length;
    if (required > 0) {
      weight += required * RISK_WEIGHTS.requiredField;
      reasons.push(`${required} required field(s)`);
    }

    const sensitive = fields.filter((f) =>
      SENSITIVE_PATTERN.test(`${f.name ?? ''} ${f.label ?? ''} ${f.type ?? ''} ${f.selector ?? ''}`)
    ).length;
    if (sensitive > 0) {
      weight += sensitive * RISK_WEIGHTS.sensitiveField;
      reasons.push(`${sensitive} sensitive field(s)`);
    }
  }

  const mutating = (node.apiEndpoints ?? []).filter((a) =>
    ['POST', 'PUT', 'PATCH', 'DELETE'].includes(a.method.toUpperCase())
  );
  if (mutating.length > 0) {
    weight += RISK_WEIGHTS.mutatingApi;
    reasons.push(`${mutating.length} observed mutating endpoint(s)`);
  }

  if ((node.wizardSteps ?? []).length > 1) {
    weight += RISK_WEIGHTS.wizard;
    reasons.push(`${node.wizardSteps!.length}-step wizard`);
  }

  const interactive = Math.min(
    (node.elementCount ?? 0) * RISK_WEIGHTS.perInteractive,
    RISK_WEIGHTS.maxInteractive
  );
  if (interactive > 0) {
    weight += interactive;
    reasons.push(`${node.elementCount} interactive element(s)`);
  }

  if (opts.authGated) {
    weight += RISK_WEIGHTS.authGated;
    reasons.push('behind authentication');
  }

  return {
    url: node.url,
    title: node.title ?? '',
    weight: Math.round(weight * 100) / 100,
    reasons,
    covered: true,
  };
}

export interface CoverageInput {
  graph: InteractionGraph;
  /** URLs discovered but never scanned. These are the gaps. */
  discoveredNotVisited: readonly string[];
  /** Origin considered authenticated, if known. */
  authGatedPathPattern?: RegExp;
}

/**
 * Compute risk-weighted coverage.
 *
 * Unvisited pages are weighted at BASELINE, because nothing is known about them
 * yet. That is a deliberate conservative choice with a consequence worth stating:
 * the metric under-penalises an unvisited checkout page, since its forms and
 * endpoints were never observed. It is a floor on the gap, not a ceiling.
 */
export function computeRiskCoverage(input: CoverageInput): RiskCoverage {
  const covered = input.graph.nodes.map((n) =>
    riskOf(n, { authGated: isAuthGated(n.url, input.authGatedPathPattern) })
  );

  const gaps: PageRisk[] = input.discoveredNotVisited.map((url) => ({
    url,
    title: '',
    // Baseline only: an unexplored page's risk is genuinely unknown.
    weight: RISK_WEIGHTS.base,
    reasons: ['never scanned — risk unknown'],
    covered: false,
  }));

  const coveredWeight = covered.reduce((sum, p) => sum + p.weight, 0);
  const gapWeight = gaps.reduce((sum, p) => sum + p.weight, 0);
  const totalWeight = coveredWeight + gapWeight;

  const meanCovered = covered.length === 0 ? 0 : coveredWeight / covered.length;

  return {
    ratio: totalWeight === 0 ? 1 : Math.round((coveredWeight / totalWeight) * 1000) / 1000,
    totalWeight: Math.round(totalWeight * 100) / 100,
    coveredWeight: Math.round(coveredWeight * 100) / 100,
    gaps: [...gaps].sort((a, b) => b.weight - a.weight),
    pagesCovered: covered.length,
    pagesKnown: covered.length + gaps.length,
    // Judged against the mean of what WAS explored, so the bar adapts to the app
    // rather than being an arbitrary constant.
    highRiskGaps: gaps.filter((g) => g.weight >= meanCovered).length,
  };
}

/** The riskiest pages that WERE covered — what the suite should prioritise. */
export function highestRiskPages(graph: InteractionGraph, limit = 10): PageRisk[] {
  return graph.nodes
    .map((n) => riskOf(n))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);
}

export function formatRiskCoverage(coverage: RiskCoverage): string {
  const pct = Math.round(coverage.ratio * 100);
  const lines = [
    `Risk-weighted coverage: ${pct}% ` +
      `(${coverage.coveredWeight} of ${coverage.totalWeight} risk units across ` +
      `${coverage.pagesCovered}/${coverage.pagesKnown} pages)`,
  ];

  if (coverage.gaps.length === 0) {
    lines.push('Every discovered page was explored.');
    return lines.join('\n');
  }

  lines.push('', `${coverage.gaps.length} discovered page(s) were never explored:`);
  for (const gap of coverage.gaps.slice(0, 15)) {
    lines.push(`  • ${gap.url}`);
  }
  if (coverage.gaps.length > 15) {
    // Never let a cap read as "that was everything".
    lines.push(`  … and ${coverage.gaps.length - 15} more`);
  }
  lines.push(
    '',
    'Note: unexplored pages are weighted at baseline because their forms and',
    'endpoints were never observed — so this figure is a FLOOR on the real gap.'
  );
  return lines.join('\n');
}

function isAuthGated(url: string, pattern?: RegExp): boolean {
  if (!pattern) return false;
  try {
    return pattern.test(new URL(url).pathname);
  } catch {
    return false;
  }
}
