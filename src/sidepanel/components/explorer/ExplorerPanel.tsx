import React, { useEffect } from 'react';
import { GitBranch, ArrowRight } from 'lucide-react';
import { ExplorerControls } from './ExplorerControls';
import { ExplorerDataControls } from './ExplorerDataControls';
import { PageGraph } from './PageGraph';
import { NextStepBanner } from '../shared/NextStepBanner';
import { useExplorerStore } from '../../stores/explorer-store';
import { useNavigationStore } from '../../stores/navigation-store';

export function ExplorerPanel() {
  const store = useExplorerStore();
  const goTo = useNavigationStore((s) => s.setActiveTab);

  useEffect(() => {
    store.loadData();
  }, []);

  return (
    <div className="flex flex-col gap-4 p-3">
      <div>
        <h2 className="text-xs font-semibold text-text-primary">Autonomous Explorer</h2>
        <p className="text-2xs text-text-muted mt-0.5">Map the app's pages, forms, and navigation</p>
      </div>

      {store.explorationJustCompleted && store.graph && (
        <NextStepBanner
          title={`App mapped — ${store.graph.nodes.length} pages, ${store.graph.edges.length} links`}
          detail="Next, learn user flows from this map on the Flows tab."
          ctaLabel="Flows"
          onContinue={() => { store.dismissExplorationCompletion(); goTo('flows'); }}
          onDismiss={store.dismissExplorationCompletion}
        />
      )}

      <ExplorerControls
        progress={store.progress}
        isExploring={store.isExploring}
        reexploringUrl={store.reexploringUrl}
      />

      <ExplorerDataControls />

      {store.error && (
        <div className="p-2.5 bg-error/10 border border-error/20 rounded-lg">
          <p className="text-xs text-error">{store.error}</p>
        </div>
      )}

      {store.graph && <PageGraph graph={store.graph} />}

      {/* Flows live on the Flows tab — link there instead of duplicating the list. */}
      {store.flows.length > 0 && (
        <button
          type="button"
          onClick={() => goTo('flows')}
          className="flex items-center justify-between gap-2 px-2.5 py-2 bg-surface-2 border border-border rounded-lg hover:border-border-light transition-colors text-left"
        >
          <span className="flex items-center gap-2 min-w-0">
            <GitBranch size={12} className="text-primary-light flex-shrink-0" />
            <span className="text-xs text-text-primary truncate">
              {store.flows.length} learned flow{store.flows.length === 1 ? '' : 's'}
            </span>
          </span>
          <span className="flex items-center gap-1 text-2xs text-text-muted flex-shrink-0">
            View on Flows tab <ArrowRight size={11} />
          </span>
        </button>
      )}
    </div>
  );
}
