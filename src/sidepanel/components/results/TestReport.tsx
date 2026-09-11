import { useState } from "react";
import { ChevronDown, ChevronRight, Clock } from 'lucide-react';
import type { TestResult } from '../../../storage/schemas';
import { verdictWithReason, isIncomplete, retrySummary } from '../../../core/report/result-adapter';
import { StatusIndicator } from '../shared/StatusIndicator';
import { FailureDetail } from './FailureDetail';

interface TestReportProps {
  results: TestResult[];
}

export function TestReport({ results }: TestReportProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <div className="space-y-1">
      {results.map((result) => {
        const isExpanded = expanded.has(result.id);
        const hasFailed = result.status !== 'passed';
        // The canonical assessment, not the raw status: a result that passed its
        // steps but needed two locators healed is not green.
        const { verdict, reason } = verdictWithReason(result);
        const running = isIncomplete(result);
        // Shown beside the verdict, not folded into it: needing a retry is a
        // diagnostic about stability, not a review requirement.
        const retry = retrySummary(result);

        return (
          <div
            key={result.id}
            className={[
              'border rounded-lg overflow-hidden',
              running
                ? 'border-primary/20 bg-primary/5'
                : verdict === 'PASS'
                ? 'border-success/20 bg-success/5'
                : verdict === 'NEEDS_REVIEW'
                ? 'border-warning/30 bg-warning/5'
                : 'border-error/20 bg-error/5',
            ].join(' ')}
          >
            <button
              className="w-full flex items-center gap-2 p-2.5 text-left"
              onClick={() => toggle(result.id)}
            >
              <StatusIndicator status={result.status} size={13} />
              <span className="flex-1 text-xs font-medium text-text-primary truncate">
                {result.testCaseTitle}
              </span>
              {verdict === 'NEEDS_REVIEW' && !running && (
                // Labelled, not just tinted: the distinction has to survive for
                // someone who cannot rely on colour.
                <span
                  className="flex-shrink-0 text-2xs font-medium px-1.5 py-0.5 rounded-full bg-warning/15 text-warning-text"
                  title={reason}
                >
                  Needs review
                </span>
              )}
              {retry?.retriedToPass && !running && (
                // A first-attempt pass and a third-attempt pass read identically
                // without this, which hides the clearest flakiness signal a run
                // produces.
                <span
                  className="flex-shrink-0 text-2xs font-medium px-1.5 py-0.5 rounded-full bg-info/15 text-info-text"
                  title={`${retry.label}. Earlier attempts failed — this test may be unstable.`}
                >
                  Retried
                </span>
              )}
              {result.duration !== undefined && (
                <span className="flex items-center gap-1 text-2xs text-text-muted flex-shrink-0">
                  <Clock size={9} />
                  {(result.duration / 1000).toFixed(1)}s
                </span>
              )}
              {isExpanded ? (
                <ChevronDown size={11} className="text-text-muted flex-shrink-0" />
              ) : (
                <ChevronRight size={11} className="text-text-muted flex-shrink-0" />
              )}
            </button>

            {isExpanded && (
              <div className="px-2.5 border-t border-current/10">
                {verdict === 'NEEDS_REVIEW' && !running && (
                  // A badge says there is something to look at; only the reason
                  // says what, and without it the verdict is not actionable.
                  <p className="py-2 text-2xs text-warning-text">{reason}</p>
                )}
                {retry && (
                  <div className="py-2 space-y-1">
                    <p className="text-2xs text-text-secondary">{retry.label}</p>
                    {(result.attempts ?? []).map((a) => (
                      <p key={a.attempt} className="text-2xs text-text-muted">
                        Attempt {a.attempt + 1}: {a.status}
                        {a.failedStepOrder !== undefined ? ` at step ${a.failedStepOrder}` : ''}
                        {a.healedLocators > 0 ? ` · ${a.healedLocators} locator(s) healed` : ''}
                        {a.freshPlan ? ' · replanned' : a.timeoutMultiplier > 1 ? ' · longer timeouts' : ''}
                        {a.failedStepError ? ` — ${a.failedStepError}` : ''}
                      </p>
                    ))}
                  </div>
                )}
                {hasFailed ? (
                  <FailureDetail result={result} />
                ) : (
                  <div className="py-2">
                    <p className="text-2xs text-text-muted">
                      Completed {result.steps.length} steps successfully
                    </p>
                    <div className="mt-1.5 space-y-0.5">
                      {result.steps.map((step, i) => (
                        <div key={i} className="flex items-center gap-1.5 text-2xs text-text-muted">
                          <StatusIndicator status="passed" size={10} />
                          <span>{step.step.description}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
