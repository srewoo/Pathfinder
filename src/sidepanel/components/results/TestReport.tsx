import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Clock } from 'lucide-react';
import type { TestResult } from '../../../storage/schemas';
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

        return (
          <div
            key={result.id}
            className={[
              'border rounded-lg overflow-hidden',
              result.status === 'passed'
                ? 'border-success/20 bg-success/5'
                : result.status === 'running'
                ? 'border-primary/20 bg-primary/5'
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
