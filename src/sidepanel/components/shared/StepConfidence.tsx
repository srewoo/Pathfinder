import React from 'react';
import type { StepConfidence } from '../../../storage/schemas';

const META: Record<StepConfidence, { color: string; label: string; title: string }> = {
  grounded: {
    color: 'bg-success',
    label: 'Grounded',
    title: 'Grounded — built from a DOM selector (or explored URL) captured during exploration. Highest fidelity.',
  },
  doc_asserted: {
    color: 'bg-info',
    label: 'Doc-asserted',
    title: 'Doc-asserted — the expected outcome is grounded in your crawled documentation.',
  },
  inferred: {
    color: 'bg-warning',
    label: 'Inferred',
    title: 'Inferred — AI-suggested. The selector is validated against the live page and self-healed at run time, but was not captured up front. Worth a glance.',
  },
};

export function StepConfidenceDot({ confidence }: { confidence: StepConfidence }) {
  const m = META[confidence];
  return (
    <span
      title={m.title}
      aria-label={m.label}
      className={`inline-block h-1.5 w-1.5 rounded-full ${m.color} flex-shrink-0`}
    />
  );
}

/** Compact legend showing only the confidence levels actually present in a test. */
export function StepConfidenceLegend({ confidences }: { confidences: StepConfidence[] }) {
  const present = (['grounded', 'doc_asserted', 'inferred'] as StepConfidence[]).filter((c) =>
    confidences.includes(c)
  );
  if (present.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      {present.map((c) => (
        <span key={c} className="flex items-center gap-1 text-2xs text-text-muted" title={META[c].title}>
          <span className={`h-1.5 w-1.5 rounded-full ${META[c].color}`} />
          {META[c].label}
        </span>
      ))}
    </div>
  );
}
