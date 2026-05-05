import React, { useEffect } from 'react';
import { GitBranch } from 'lucide-react';
import { ExplorerControls } from './ExplorerControls';
import { ExplorerDataControls } from './ExplorerDataControls';
import { PageGraph } from './PageGraph';
import { useExplorerStore } from '../../stores/explorer-store';
import { Badge } from '../shared/Badge';

export function ExplorerPanel() {
  const store = useExplorerStore();

  useEffect(() => {
    store.loadData();
  }, []);

  return (
    <div className="flex flex-col gap-4 p-3">
      <div>
        <h2 className="text-xs font-semibold text-text-primary">Autonomous Explorer</h2>
        <p className="text-2xs text-text-muted mt-0.5">Navigate the app to discover user flows</p>
      </div>

      <ExplorerControls
        progress={store.progress}
        isExploring={store.isExploring}
        reexploringUrl={store.reexploringUrl}
        isLearningFlows={store.isLearningFlows}
      />

      <ExplorerDataControls />

      {store.error && (
        <div className="p-2.5 bg-error/10 border border-error/20 rounded-lg">
          <p className="text-xs text-error">{store.error}</p>
        </div>
      )}

      {store.graph && <PageGraph graph={store.graph} />}

      {store.flows.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <GitBranch size={12} className="text-primary-light" />
            <span className="text-2xs font-medium text-text-muted uppercase tracking-wide">
              Learned Flows ({store.flows.length})
            </span>
          </div>
          <div className="space-y-2">
            {store.flows.map((flow) => (
              <div key={flow.flowId} className="p-2.5 bg-surface-2 border border-border rounded-lg">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-text-primary">{flow.name}</p>
                    <p className="text-2xs text-text-muted mt-0.5">{flow.description}</p>
                    {flow.startUrl && (
                      <div className="mt-1 space-y-1">
                        <div className="flex items-center gap-2">
                          <p className="text-2xs text-text-muted font-mono truncate">{flow.startUrl}</p>
                          {flow.startUrlInference && (
                            <Badge variant={confidenceVariant(flow.startUrlInference.confidence)}>
                              {flow.startUrlInference.confidence}
                            </Badge>
                          )}
                        </div>
                        {flow.startUrlInference && (
                          <p className="text-2xs text-text-muted">
                            {flow.startUrlInference.reason}
                          </p>
                        )}
                      </div>
                    )}
                    <p className="text-2xs text-text-muted mt-1">{flow.steps.length} steps · {flow.source}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
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
