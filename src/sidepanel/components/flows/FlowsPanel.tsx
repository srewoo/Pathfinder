import React, { useEffect, useState } from 'react';
import { GitBranch, ChevronDown, ChevronRight, Wand2, Trash2, Loader2, CheckSquare, Square } from 'lucide-react';
import { getAllFlows, deleteFlow } from '../../../core/flow/flow-store';
import type { Flow } from '../../../storage/schemas';
import { Button } from '../shared/Button';
import { Badge } from '../shared/Badge';
import { useTestStore } from '../../stores/test-store';
import { useExplorerStore } from '../../stores/explorer-store';
import { useNavigationStore } from '../../stores/navigation-store';

export function FlowsPanel() {
  const [flows, setFlows] = useState<Flow[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [generating, setGenerating] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ mode: 'all' | 'selected'; done: number; total: number } | null>(null);
  const [selectedFlowIds, setSelectedFlowIds] = useState<Set<string>>(new Set());
  const { generateTestsForFlow } = useTestStore();
  const learnFlows = useExplorerStore((s) => s.learnFlows);
  const isLearningFlows = useExplorerStore((s) => s.isLearningFlows);
  const hasGraph = useExplorerStore((s) => Boolean(s.graph));
  const learnError = useExplorerStore((s) => s.error);
  const goTo = useNavigationStore((s) => s.setActiveTab);

  useEffect(() => {
    loadFlows();
    // Know whether exploration data exists (gates the Learn Flows CTA).
    useExplorerStore.getState().loadData();
  }, []);

  // The Learn Flows action lives here now; reload the list when it finishes
  // (the explorer store clears isLearningFlows when FLOWS_LEARNED arrives).
  useEffect(() => {
    if (!isLearningFlows) loadFlows();
  }, [isLearningFlows]);

  const loadFlows = async () => {
    const all = await getAllFlows();
    setFlows(all);
  };

  const handleDelete = async (flowId: string) => {
    await deleteFlow(flowId);
    setFlows((prev) => prev.filter((f) => f.flowId !== flowId));
    setSelectedFlowIds((prev) => { const n = new Set(prev); n.delete(flowId); return n; });
  };

  const handleGenerate = async (flowId: string) => {
    setGenerating(flowId);
    await generateTestsForFlow(flowId);
    setGenerating(null);
  };

  const runGeneration = async (mode: 'all' | 'selected', targets: Flow[]) => {
    if (targets.length === 0) return;
    setProgress({ mode, done: 0, total: targets.length });
    try {
      for (let i = 0; i < targets.length; i++) {
        setGenerating(targets[i].flowId);
        await generateTestsForFlow(targets[i].flowId);
        setProgress((p) => (p ? { ...p, done: i + 1 } : p));
      }
    } finally {
      setGenerating(null);
      setProgress(null);
    }
  };

  const handleGenerateSelected = () =>
    runGeneration('selected', flows.filter((f) => selectedFlowIds.has(f.flowId)));

  const handleGenerateAll = () => runGeneration('all', flows);

  const handleDeleteSelected = async () => {
    const ids = Array.from(selectedFlowIds);
    if (ids.length === 0) return;
    const ok = window.confirm(
      `Delete ${ids.length} selected flow${ids.length === 1 ? '' : 's'}? This cannot be undone.`
    );
    if (!ok) return;
    await Promise.all(ids.map((id) => deleteFlow(id)));
    setFlows((prev) => prev.filter((f) => !selectedFlowIds.has(f.flowId)));
    setSelectedFlowIds(new Set());
  };

  const handleDeleteAll = async () => {
    if (flows.length === 0) return;
    const ok = window.confirm(
      `Delete ALL ${flows.length} flows? This cannot be undone.`
    );
    if (!ok) return;
    await Promise.all(flows.map((f) => deleteFlow(f.flowId)));
    setFlows([]);
    setSelectedFlowIds(new Set());
  };

  const toggleSelect = (flowId: string) => {
    setSelectedFlowIds((prev) => {
      const next = new Set(prev);
      next.has(flowId) ? next.delete(flowId) : next.add(flowId);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedFlowIds.size === flows.length) {
      setSelectedFlowIds(new Set());
    } else {
      setSelectedFlowIds(new Set(flows.map((f) => f.flowId)));
    }
  };

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const isGenerating = Boolean(generating);
  const allSelected = flows.length > 0 && selectedFlowIds.size === flows.length;
  const someSelected = selectedFlowIds.size > 0 && !allSelected;

  const learnButton = (
    <Button
      variant={flows.length === 0 ? 'primary' : 'secondary'}
      size="xs"
      loading={isLearningFlows}
      icon={<GitBranch size={11} />}
      onClick={learnFlows}
      disabled={isLearningFlows || !hasGraph}
      title={hasGraph ? 'Learn user flows from exploration + knowledge' : 'Explore the app first'}
    >
      {isLearningFlows ? 'Learning…' : flows.length === 0 ? 'Learn Flows from Exploration' : 'Re-learn Flows'}
    </Button>
  );

  if (flows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 py-12 text-center px-4">
        <GitBranch size={32} className="text-text-muted mb-3" />
        <p className="text-xs font-medium text-text-secondary">No flows learned yet</p>
        {hasGraph ? (
          <>
            <p className="text-2xs text-text-muted mt-1 mb-3">
              Exploration data is ready — learn flows in one click. Captures every page, form, modal, and feature tab.
            </p>
            {learnButton}
          </>
        ) : (
          <button
            type="button"
            onClick={() => goTo('explore')}
            className="text-2xs text-primary-light hover:underline mt-1"
          >
            Go to Explore → Start Exploration first
          </button>
        )}
        {learnError && <p className="text-2xs text-error mt-3 max-w-xs">{learnError}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-xs font-semibold text-text-primary">Learned Flows</h2>
          <p className="text-2xs text-text-muted mt-0.5">{flows.length} flows · generate test cases from them below</p>
        </div>
        {learnButton}
      </div>

      {learnError && (
        <div className="p-2.5 bg-error/10 border border-error/20 rounded-lg">
          <p className="text-xs text-error">{learnError}</p>
        </div>
      )}

      {/* Bulk action bar */}
      <div className="flex items-center gap-2 bg-surface-2 border border-border rounded-lg px-2.5 py-2 whitespace-nowrap overflow-x-auto">
        <button
          onClick={toggleSelectAll}
          className="flex items-center gap-1.5 text-2xs text-text-secondary hover:text-text-primary flex-shrink-0"
          disabled={isGenerating}
          title={allSelected ? 'Deselect all' : 'Select all'}
        >
          {allSelected ? (
            <CheckSquare size={13} className="text-primary" />
          ) : someSelected ? (
            <CheckSquare size={13} className="text-primary opacity-50" />
          ) : (
            <Square size={13} className="text-text-muted" />
          )}
          <span className="font-medium">
            {selectedFlowIds.size > 0 ? `${selectedFlowIds.size} selected` : 'Select all'}
          </span>
        </button>

        <div className="flex-1" />

        <Button
          variant={selectedFlowIds.size > 0 ? 'success' : 'ghost'}
          size="xs"
          loading={progress?.mode === 'selected'}
          icon={<Wand2 size={10} />}
          onClick={handleGenerateSelected}
          disabled={isGenerating || selectedFlowIds.size === 0}
          title="Generate test cases for the selected flows"
        >
          {progress?.mode === 'selected'
            ? `Generating ${progress.done}/${progress.total}…`
            : selectedFlowIds.size > 0
              ? `Generate Tests (${selectedFlowIds.size})`
              : 'Generate Tests'}
        </Button>

        <Button
          variant="primary"
          size="xs"
          loading={progress?.mode === 'all'}
          icon={<Wand2 size={10} />}
          onClick={handleGenerateAll}
          disabled={isGenerating}
          title="Generate test cases for all flows"
        >
          {progress?.mode === 'all'
            ? `Generating ${progress.done}/${progress.total}…`
            : 'Generate All Tests'}
        </Button>

        <Button
          variant="danger"
          size="xs"
          icon={<Trash2 size={10} />}
          onClick={selectedFlowIds.size > 0 ? handleDeleteSelected : handleDeleteAll}
          disabled={isGenerating}
          title={selectedFlowIds.size > 0 ? `Delete ${selectedFlowIds.size} selected flow${selectedFlowIds.size === 1 ? '' : 's'}` : 'Delete all flows'}
        >
          {selectedFlowIds.size > 0 ? `Delete Flows (${selectedFlowIds.size})` : 'Delete All Flows'}
        </Button>
      </div>

      {/* Flow list */}
      <div className="space-y-1.5">
        {flows.map((flow) => {
          const isExpanded = expanded.has(flow.flowId);
          const isThisGenerating = generating === flow.flowId;
          const isSelected = selectedFlowIds.has(flow.flowId);

          return (
            <div
              key={flow.flowId}
              className={`bg-surface-2 border rounded-lg overflow-hidden transition-colors ${
                isSelected ? 'border-primary/40' : 'border-border'
              }`}
            >
              <div className="flex items-center gap-2 p-2.5">
                {/* Checkbox */}
                <button
                  onClick={() => toggleSelect(flow.flowId)}
                  className="flex-shrink-0 text-text-muted hover:text-primary"
                  disabled={isGenerating}
                  title={isSelected ? 'Deselect' : 'Select'}
                >
                  {isSelected ? (
                    <CheckSquare size={12} className="text-primary" />
                  ) : (
                    <Square size={12} />
                  )}
                </button>

                <button
                  onClick={() => toggle(flow.flowId)}
                  className="flex-1 flex items-center gap-2 min-w-0 text-left"
                >
                  {isExpanded ? (
                    <ChevronDown size={11} className="text-text-muted flex-shrink-0" />
                  ) : (
                    <ChevronRight size={11} className="text-text-muted flex-shrink-0" />
                  )}
                  <GitBranch size={11} className="text-primary-light flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-medium text-text-primary">{flow.name}</span>
                    <Badge variant="neutral" className="ml-2">{flow.source}</Badge>
                  </div>
                  <span className="text-2xs text-text-muted flex-shrink-0">
                    {flow.steps.length} steps
                  </span>
                </button>

                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="xs"
                    icon={isThisGenerating ? <Loader2 size={10} className="animate-spin" /> : <Wand2 size={10} />}
                    onClick={() => handleGenerate(flow.flowId)}
                    disabled={isGenerating}
                    title="Generate tests for this flow"
                  />
                  <Button
                    variant="ghost"
                    size="xs"
                    icon={<Trash2 size={10} />}
                    onClick={() => handleDelete(flow.flowId)}
                    disabled={isGenerating}
                    title="Delete flow"
                  />
                </div>
              </div>

              {isExpanded && (
                <div className="px-3 pb-3 border-t border-border">
                  <p className="text-2xs text-text-secondary mt-2 mb-2">{flow.description}</p>
                  {flow.startUrl && (
                    <div className="mb-2 space-y-1">
                      <div className="flex items-center gap-2">
                        <p className="text-2xs text-text-muted font-mono truncate">{flow.startUrl}</p>
                        {flow.startUrlInference && (
                          <Badge variant={confidenceVariant(flow.startUrlInference.confidence)}>
                            {flow.startUrlInference.confidence}
                          </Badge>
                        )}
                        {flow.startUrlInference && (
                          <Badge variant="neutral">{flow.startUrlInference.method}</Badge>
                        )}
                      </div>
                      {flow.startUrlInference && (
                        <p className="text-2xs text-text-muted">{flow.startUrlInference.reason}</p>
                      )}
                    </div>
                  )}
                  <div className="space-y-1">
                    {flow.steps.map((step) => (
                      <div
                        key={step.order}
                        className="flex items-start gap-2 text-2xs text-text-muted"
                      >
                        <span className="text-primary-light font-mono w-4 flex-shrink-0">
                          {step.order}.
                        </span>
                        <span className="font-mono text-text-secondary">{step.action}</span>
                        {step.target && (
                          <span className="text-text-muted">→ {step.target}</span>
                        )}
                        <span className="flex-1 text-text-muted">{step.description}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function confidenceVariant(confidence: 'high' | 'medium' | 'low'): 'success' | 'warning' | 'neutral' {
  switch (confidence) {
    case 'high':
      return 'success';
    case 'medium':
      return 'warning';
    default:
      return 'neutral';
  }
}
