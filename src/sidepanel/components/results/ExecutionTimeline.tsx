import React from 'react';
import { CheckCircle, XCircle, MinusCircle, Wrench, Clock, ChevronDown, ChevronRight } from 'lucide-react';
import type { TestResult, StepResult } from '../../../storage/schemas';

interface Props {
  result: TestResult;
}

export function ExecutionTimeline({ result }: Props) {
  const [expanded, setExpanded] = React.useState(true);

  const totalDuration = result.duration ?? 0;

  return (
    <div className="bg-surface-2 border border-border rounded-lg overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 p-2.5 text-left hover:bg-surface-3 transition-colors"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <StatusBadge status={result.status} />
        <span className="text-xs font-medium text-text-primary flex-1 truncate">
          {result.testCaseTitle}
        </span>
        <span className="text-2xs text-text-muted flex items-center gap-1">
          <Clock size={10} />
          {formatDuration(totalDuration)}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border px-3 py-2">
          {/* Duration bar */}
          <div className="h-2 bg-surface-3 rounded-full overflow-hidden mb-3 relative">
            {result.steps.map((step, i) => {
              const offset = getStepOffset(result.steps, i, totalDuration);
              const width = totalDuration > 0 ? (step.duration / totalDuration) * 100 : 0;
              const color = step.status === 'passed' ? 'bg-success'
                : step.status === 'failed' ? 'bg-error'
                : 'bg-text-muted';
              return (
                <div
                  key={i}
                  className={`absolute top-0 h-full ${color}`}
                  style={{ left: `${offset}%`, width: `${Math.max(width, 0.5)}%` }}
                  title={`Step ${step.step.order}: ${step.step.description} (${formatDuration(step.duration)})`}
                />
              );
            })}
          </div>

          {/* Step timeline */}
          <div className="flex flex-col relative">
            {/* Timeline line */}
            <div className="absolute left-[9px] top-3 bottom-3 w-px bg-border" />

            {result.steps.map((step, i) => (
              <TimelineStep key={i} step={step} isLast={i === result.steps.length - 1} />
            ))}
          </div>

          {/* Summary footer */}
          <div className="flex items-center gap-3 mt-2 pt-2 border-t border-border text-2xs text-text-muted">
            <span>{result.steps.filter((s) => s.status === 'passed').length} passed</span>
            <span>{result.steps.filter((s) => s.status === 'failed').length} failed</span>
            <span>{result.steps.filter((s) => s.status === 'skipped').length} skipped</span>
            {result.healingAttempts.length > 0 && (
              <span className="flex items-center gap-0.5 text-info">
                <Wrench size={9} />
                {result.healingAttempts.filter((h) => h.success).length} healed
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TimelineStep({ step, isLast }: { step: StepResult; isLast: boolean }) {
  const [showDetails, setShowDetails] = React.useState(step.status === 'failed');

  return (
    <div className={`flex gap-2 ${isLast ? '' : 'pb-1.5'}`}>
      {/* Icon */}
      <div className="flex-shrink-0 z-10 bg-surface-2">
        {step.status === 'passed' && <CheckCircle size={18} className="text-success" />}
        {step.status === 'failed' && <XCircle size={18} className="text-error" />}
        {step.status === 'skipped' && <MinusCircle size={18} className="text-text-muted" />}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 pb-1">
        <button
          onClick={() => setShowDetails(!showDetails)}
          className="w-full text-left"
        >
          <div className="flex items-center gap-1.5">
            <span className="text-2xs font-medium text-text-primary truncate">
              {step.step.description}
            </span>
          </div>
          <div className="flex items-center gap-2 text-2xs text-text-muted mt-0.5">
            <span className="uppercase text-primary/70 font-medium">{step.step.action}</span>
            {step.step.selector && (
              <code className="text-text-muted/60 truncate max-w-[120px]">{step.step.selector}</code>
            )}
            <span className="ml-auto">{formatDuration(step.duration)}</span>
          </div>
        </button>

        {/* Expanded details */}
        {showDetails && (
          <div className="mt-1.5 space-y-1">
            {step.error && (
              <div className="text-2xs bg-error/10 border border-error/20 rounded px-2 py-1 text-error font-mono break-all">
                {step.error}
              </div>
            )}
            {step.healingAttempt && (
              <div className="text-2xs bg-info/10 border border-info/20 rounded px-2 py-1 text-info flex items-center gap-1">
                <Wrench size={9} />
                Healed via {step.healingAttempt.method}
                {step.healingAttempt.healedSelector && (
                  <code className="ml-1">{step.healingAttempt.healedSelector}</code>
                )}
              </div>
            )}
            {step.screenshot && (
              <details className="mt-1">
                <summary className="text-2xs text-primary cursor-pointer">Show screenshot</summary>
                <img
                  src={step.screenshot.startsWith('data:') ? step.screenshot : `data:image/png;base64,${step.screenshot}`}
                  alt="Step failure screenshot"
                  className="mt-1 rounded border border-border max-w-full"
                  loading="lazy"
                />
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const config = {
    passed: { bg: 'bg-success/15', text: 'text-success', label: 'PASS' },
    failed: { bg: 'bg-error/15', text: 'text-error', label: 'FAIL' },
    error: { bg: 'bg-warning/15', text: 'text-warning', label: 'ERR' },
    running: { bg: 'bg-info/15', text: 'text-info', label: 'RUN' },
  }[status] ?? { bg: 'bg-surface-3', text: 'text-text-muted', label: '?' };

  return (
    <span className={`${config.bg} ${config.text} text-2xs font-bold px-1.5 py-0.5 rounded`}>
      {config.label}
    </span>
  );
}

function getStepOffset(steps: StepResult[], index: number, totalDuration: number): number {
  if (totalDuration === 0) return 0;
  let offset = 0;
  for (let i = 0; i < index; i++) {
    offset += steps[i].duration;
  }
  return (offset / totalDuration) * 100;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60000)}m`;
}
