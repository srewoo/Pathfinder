import { useState } from 'react';
import { Play, Trash2, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import type { TestCase, Flow } from '../../../storage/schemas';
import { Badge } from '../shared/Badge';
import { StatusIndicator } from '../shared/StatusIndicator';
import { Button } from '../shared/Button';
import { StepConfidenceDot, StepConfidenceLegend } from '../shared/StepConfidence';
import { RetryTestModal } from './RetryTestModal';
import type { LiveStepResult } from '../../stores/test-store';

interface TestCaseListProps {
  testCases: TestCase[];
  selectedTestIds: string[];
  runningTestIds: string[];
  liveStepResults: Record<string, LiveStepResult[]>;
  onRun: (id: string) => void;
  onDelete: (id: string) => void;
  onRegenerate: (id: string, context: string) => void;
  onToggleSelection: (id: string) => void;
  onSelectAll: () => void;
  onSelectFailed: () => void;
  onClearSelection: () => void;
  onDeleteSelected: () => void;
}

export function TestCaseList({
  testCases,
  selectedTestIds,
  runningTestIds,
  liveStepResults,
  onRun,
  onDelete,
  onRegenerate,
  onToggleSelection,
  onSelectAll,
  onSelectFailed,
  onClearSelection,
  onDeleteSelected,
}: TestCaseListProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [regenerateTarget, setRegenerateTarget] = useState<{id: string, name: string} | null>(null);
  const [confirmingBulkDelete, setConfirmingBulkDelete] = useState(false);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  if (testCases.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <p className="text-xs text-text-secondary font-medium">No test cases yet</p>
        <p className="text-2xs text-text-muted mt-1">
          Generate them from the Flows tab, or add a one-line check above
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {testCases.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <p className="text-2xs font-medium text-text-muted uppercase tracking-wide">
              Test Cases ({testCases.length})
            </p>
            <div className="flex items-center gap-1">
              <Badge variant="neutral">{selectedTestIds.length} selected</Badge>
              <Button variant="ghost" size="xs" onClick={onSelectAll}>
                Select all
              </Button>
              <Button variant="ghost" size="xs" onClick={onSelectFailed}>
                Select failed
              </Button>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => { onClearSelection(); setConfirmingBulkDelete(false); }}
                disabled={selectedTestIds.length === 0}
              >
                Clear
              </Button>
              {confirmingBulkDelete ? (
                <>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="text-error hover:text-error"
                    icon={<Trash2 size={10} />}
                    onClick={() => { onDeleteSelected(); setConfirmingBulkDelete(false); }}
                  >
                    Confirm delete {selectedTestIds.length}
                  </Button>
                  <Button variant="ghost" size="xs" onClick={() => setConfirmingBulkDelete(false)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button
                  variant="ghost"
                  size="xs"
                  className="text-error hover:text-error"
                  icon={<Trash2 size={10} />}
                  onClick={() => setConfirmingBulkDelete(true)}
                  disabled={selectedTestIds.length === 0}
                >
                  Delete
                </Button>
              )}
            </div>
          </div>
          {testCases.map((tc) => {
            const isExpanded = expanded.has(tc.id);
            const isRunning = runningTestIds.includes(tc.id);
            const liveSteps = liveStepResults[tc.id] ?? [];
            const isSelected = selectedTestIds.includes(tc.id);

            return (
              <div
                key={tc.id}
                className="bg-surface-2 border border-border rounded-lg overflow-hidden"
              >
                <div className="flex items-center gap-2 p-2">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => onToggleSelection(tc.id)}
                    disabled={isRunning}
                    aria-label={`Select test ${tc.title}`}
                    className="h-3.5 w-3.5 rounded border-border bg-surface-1 text-primary focus:ring-primary/50"
                  />
                  <StatusIndicator status={isRunning ? 'running' : tc.status} />
                  <button
                    className="flex-1 flex items-center gap-1 min-w-0 text-left"
                    onClick={() => toggle(tc.id)}
                  >
                    <span className="text-xs text-text-primary truncate">{tc.title}</span>
                    <Badge variant={tc.type} className="flex-shrink-0">
                      {tc.type}
                    </Badge>
                    <Badge variant="neutral" className="flex-shrink-0">
                      {tc.source}
                    </Badge>
                    {tc.executionPresetName && (
                      <Badge variant="info" className="flex-shrink-0">
                        {tc.executionPresetName}
                      </Badge>
                    )}
                    {isExpanded ? (
                      <ChevronDown size={10} className="text-text-muted flex-shrink-0" />
                    ) : (
                      <ChevronRight size={10} className="text-text-muted flex-shrink-0" />
                    )}
                  </button>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <Button
                      variant="ghost"
                      size="xs"
                      icon={<Play size={10} />}
                      onClick={() => onRun(tc.id)}
                      disabled={runningTestIds.length > 0}
                      title="Run this test"
                    />
                    <Button
                      variant="ghost"
                      size="xs"
                      icon={<RefreshCw size={10} />}
                      onClick={() => setRegenerateTarget({ id: tc.id, name: tc.title })}
                      disabled={isRunning}
                      title="Regenerate Steps"
                    />
                    <Button
                      variant="ghost"
                      size="xs"
                      icon={<Trash2 size={10} />}
                      onClick={() => onDelete(tc.id)}
                      disabled={isRunning}
                      title="Delete"
                    />
                  </div>
                </div>

                {isExpanded && (
                  <div className="px-3 pb-2.5 border-t border-border bg-surface-1">
                    <p className="text-2xs text-text-secondary mt-2">{tc.description}</p>
                    {(tc.personaLabel || tc.requiresAuthenticatedSession) && (
                      <p className="text-2xs text-text-muted mt-1">
                        {tc.personaLabel ? `Persona: ${tc.personaLabel}` : 'Preset applied'}
                        {tc.requiresAuthenticatedSession ? ' • Authenticated session required' : ''}
                      </p>
                    )}
                    {tc.startUrl && (
                      <p className="text-2xs text-text-muted font-mono mt-2 truncate">{tc.startUrl}</p>
                    )}

                    {tc.setupSteps && tc.setupSteps.length > 0 && (
                      <div className="mt-2 rounded-lg border border-info/20 bg-info/5 p-2.5">
                        <p className="text-2xs font-medium text-text-primary">Setup block</p>
                        <ol className="mt-1 space-y-0.5">
                          {tc.setupSteps.map((step, index) => (
                            <li key={`${tc.id}-setup-${index}`} className="text-2xs text-text-secondary flex gap-1.5">
                              <span className="font-mono text-info">{index + 1}.</span>
                              <span>{step}</span>
                            </li>
                          ))}
                        </ol>
                      </div>
                    )}

                    {liveSteps.length > 0 && (
                      <div className="mt-2 rounded-lg border border-primary/20 bg-primary/5 p-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-2xs font-medium text-text-primary">Live execution</p>
                          <Badge variant="primary">{liveSteps.length} steps</Badge>
                        </div>
                        <div className="mt-2 space-y-1">
                          {liveSteps.map((step) => (
                            <div key={`${tc.id}-${step.stepOrder}`} className="flex items-start gap-2 text-2xs">
                              <StatusIndicator status={step.status} size={11} />
                              <span className="font-mono text-text-secondary">{step.action}</span>
                              <span className="text-text-primary flex-1">{step.description}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {tc.steps && tc.steps.length > 0 && (
                      <>
                        {tc.stepConfidence && tc.stepConfidence.length > 0 && (
                          <div className="mt-2">
                            <StepConfidenceLegend confidences={tc.stepConfidence} />
                          </div>
                        )}
                        <ol className="mt-1.5 space-y-0.5">
                          {tc.steps.map((step, i) => (
                            <li key={i} className="text-2xs text-text-muted flex gap-1.5 items-start">
                              <span className="text-primary-light font-mono">{i + 1}.</span>
                              {tc.stepConfidence?.[i] && (
                                <span className="mt-[3px]">
                                  <StepConfidenceDot confidence={tc.stepConfidence[i]} />
                                </span>
                              )}
                              <span>{step}</span>
                            </li>
                          ))}
                        </ol>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <RetryTestModal
        isOpen={regenerateTarget !== null}
        testCaseName={regenerateTarget?.name ?? ''}
        onClose={() => setRegenerateTarget(null)}
        onSubmit={(context) => {
          if (regenerateTarget) {
            onRegenerate(regenerateTarget.id, context);
            setRegenerateTarget(null);
          }
        }}
      />
    </div>
  );
}

export function FlowList({ flows }: { flows: Flow[] }) {
  return (
    <div className="space-y-1">
      {flows.map((flow) => (
        <div key={flow.flowId} className="p-2 bg-surface-2 border border-border rounded-lg">
          <p className="text-xs font-medium text-text-primary">{flow.name}</p>
          <p className="text-2xs text-text-muted">{flow.steps.length} steps</p>
        </div>
      ))}
    </div>
  );
}
