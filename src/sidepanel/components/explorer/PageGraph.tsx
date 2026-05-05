import React from 'react';
import { Network, RefreshCw } from 'lucide-react';
import type { InteractionGraph } from '../../../storage/schemas';
import { useExplorerStore } from '../../stores/explorer-store';

interface PageGraphProps {
  graph: InteractionGraph;
}

export function PageGraph({ graph }: PageGraphProps) {
  const { reexplorePage, isExploring, reexploringUrl } = useExplorerStore();

  if (graph.nodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-6">
        <Network size={24} className="text-text-muted mb-2" />
        <p className="text-xs text-text-muted">No pages explored yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-2xs font-medium text-text-muted uppercase tracking-wide">
          Page Graph
        </span>
        <span className="text-2xs text-text-muted">
          {graph.nodes.length} nodes · {graph.edges.length} edges
        </span>
      </div>

      <div className="space-y-1 overflow-y-auto scrollbar-thin">
        {graph.nodes.map((node) => {
          const outgoing = graph.edges.filter((e) => e.from === node.url);
          const isReexploringThis = reexploringUrl === node.url;

          let displayTitle: string;
          try {
            displayTitle = node.title || new URL(node.url).pathname || '/';
          } catch {
            displayTitle = node.url;
          }

          return (
            <div
              key={node.id}
              className={[
                'p-2 border rounded-lg text-xs transition-colors',
                isReexploringThis
                  ? 'bg-primary-dim border-primary/30'
                  : 'bg-surface-2 border-border',
              ].join(' ')}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="text-text-primary font-medium truncate min-w-0 flex-1">
                  {displayTitle}
                </span>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <span className="text-2xs text-text-muted">{node.elementCount} el.</span>
                  <button
                    title="Re-explore this page"
                    disabled={isExploring}
                    onClick={() => reexplorePage(node.url)}
                    className={[
                      'p-0.5 rounded transition-colors',
                      isReexploringThis
                        ? 'text-primary'
                        : 'text-text-muted hover:text-text-secondary disabled:opacity-40',
                    ].join(' ')}
                  >
                    <RefreshCw
                      size={10}
                      className={isReexploringThis ? 'animate-spin' : ''}
                    />
                  </button>
                </div>
              </div>

              {outgoing.length > 0 && (
                <div className="mt-1 space-y-0.5">
                  {outgoing.slice(0, 2).map((edge, i) => {
                    const toNode = graph.nodes.find((n) => n.url === edge.to);
                    let toLabel: string;
                    try {
                      toLabel = toNode?.title || new URL(edge.to).pathname || edge.to;
                    } catch {
                      toLabel = edge.to;
                    }
                    return (
                      <div key={i} className="flex items-center gap-1 text-2xs text-text-muted overflow-hidden">
                        <span className="text-primary-light flex-shrink-0">→</span>
                        <span className="truncate min-w-0 flex-1">{toLabel}</span>
                        {edge.label && (
                          <span className="text-text-muted opacity-60 flex-shrink-0 truncate max-w-[6rem]">
                            via {edge.label}
                          </span>
                        )}
                      </div>
                    );
                  })}
                  {outgoing.length > 2 && (
                    <div className="text-2xs text-text-muted">+{outgoing.length - 2} more</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
