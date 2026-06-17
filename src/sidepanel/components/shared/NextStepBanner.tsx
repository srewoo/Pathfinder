import React from 'react';
import { CheckCircle2, ArrowRight, X } from 'lucide-react';

interface NextStepBannerProps {
  /** Headline confirming what just finished, e.g. "App mapped — 24 pages". */
  title: string;
  /** Optional secondary line. */
  detail?: string;
  /** Label on the primary forward action, e.g. "Learn Flows". */
  ctaLabel: string;
  onContinue: () => void;
  /** When provided, shows a dismiss "X". */
  onDismiss?: () => void;
}

/**
 * Success → "Continue to next stage" hand-off. The single biggest UX fix for a
 * linear pipeline: when a stage finishes, tell the user it worked and give them
 * one obvious button to the next step instead of a dead-end. Mirrors the
 * auto-advance the execute→results stages already do.
 */
export function NextStepBanner({ title, detail, ctaLabel, onContinue, onDismiss }: NextStepBannerProps) {
  return (
    <div className="flex items-center gap-2.5 p-2.5 bg-success/10 border border-success/30 rounded-lg">
      <CheckCircle2 size={16} className="text-success flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-text-primary truncate">{title}</p>
        {detail && <p className="text-2xs text-text-muted mt-0.5">{detail}</p>}
      </div>
      <button
        type="button"
        onClick={onContinue}
        className="flex items-center gap-1 px-2.5 py-1 text-2xs font-medium rounded-md bg-primary text-white hover:bg-primary-light transition-colors flex-shrink-0"
      >
        {ctaLabel} <ArrowRight size={12} />
      </button>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="text-text-muted hover:text-text-secondary transition-colors flex-shrink-0"
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
}
