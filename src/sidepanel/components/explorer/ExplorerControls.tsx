import React, { useEffect, useState } from 'react';
import { Play, Square, GitBranch, Loader2, Globe } from 'lucide-react';
import { Button } from '../shared/Button';
import { useExplorerStore } from '../../stores/explorer-store';
import type { ExplorationProgress } from '../../../storage/schemas';

interface ExplorerControlsProps {
  progress: ExplorationProgress | null;
  isExploring: boolean;
  reexploringUrl: string | null;
  isLearningFlows: boolean;
}

export function ExplorerControls({ progress, isExploring, reexploringUrl, isLearningFlows }: ExplorerControlsProps) {
  const store = useExplorerStore();
  const [currentTabUrl, setCurrentTabUrl] = useState<string>('');

  // Show user which page will be used as the exploration starting point
  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const url = tabs[0]?.url ?? '';
      setCurrentTabUrl(url);
    });
  }, [isExploring]);

  let startLabel: string;
  try {
    startLabel = currentTabUrl ? new URL(currentTabUrl).hostname + new URL(currentTabUrl).pathname : '...';
  } catch {
    startLabel = currentTabUrl;
  }

  const showProgress = progress && (isExploring || progress.status === 'running');

  return (
    <div className="space-y-3">
      {/* Single-page toggle — only visible when not a re-explore */}
      {!reexploringUrl && (
        <div className="flex items-start justify-between gap-3 px-2.5 py-2 bg-surface-2 border border-border rounded-lg">
          <div className="flex-1 min-w-0">
            <label htmlFor="single-page-toggle" className="block text-2xs font-medium text-text-primary cursor-pointer">
              Single page only
            </label>
            <p className="text-2xs text-text-muted mt-0.5">
              Scan only the current tab URL and its components — no link following.
            </p>
          </div>
          <button
            id="single-page-toggle"
            type="button"
            role="switch"
            aria-checked={store.singlePageOnly}
            disabled={isExploring}
            onClick={() => store.setSinglePageOnly(!store.singlePageOnly)}
            className={[
              'relative inline-flex h-4 w-7 flex-shrink-0 items-center rounded-full transition-colors',
              store.singlePageOnly ? 'bg-primary' : 'bg-surface-3 border border-border',
              'disabled:opacity-50',
            ].join(' ')}
          >
            <span
              className={[
                'inline-block h-3 w-3 transform rounded-full bg-white transition-transform',
                store.singlePageOnly ? 'translate-x-3.5' : 'translate-x-0.5',
              ].join(' ')}
            />
          </button>
        </div>
      )}

      {/* Depth selector — hidden when single-page is on or this is a re-explore */}
      {!reexploringUrl && !store.singlePageOnly && (
        <div>
          <label className="block text-2xs font-medium text-text-muted mb-1">Exploration Depth</label>
          <div className="flex items-center gap-2">
            {[1, 2, 3, 4, 5].map((d) => (
              <button
                key={d}
                onClick={() => store.setDepth(d)}
                disabled={isExploring}
                className={[
                  'w-7 h-7 rounded text-xs font-medium transition-colors border',
                  store.explorationDepth === d
                    ? 'bg-primary text-white border-primary'
                    : 'bg-surface-3 text-text-muted border-border hover:border-border-light',
                  'disabled:opacity-50',
                ].join(' ')}
              >
                {d}
              </button>
            ))}
          </div>
          <p className="text-2xs text-text-muted mt-1">
            Higher depth discovers more pages but takes longer.
          </p>
        </div>
      )}

      {/* Current page indicator */}
      {!isExploring && currentTabUrl && (
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-surface-2 border border-border rounded-lg">
          <Globe size={10} className="text-text-muted flex-shrink-0" />
          <span className="text-2xs text-text-muted truncate">Will explore from: </span>
          <span className="text-2xs text-text-primary font-mono truncate">{startLabel}</span>
        </div>
      )}

      {/* Re-explore indicator */}
      {isExploring && reexploringUrl && (
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-primary-dim border border-primary/30 rounded-lg">
          <Loader2 size={10} className="text-primary flex-shrink-0 animate-spin" />
          <span className="text-2xs text-primary truncate">Re-exploring: </span>
          <span className="text-2xs text-text-primary font-mono truncate">
            {(() => { try { return new URL(reexploringUrl).pathname; } catch { return reexploringUrl; } })()}
          </span>
        </div>
      )}

      <div className="flex gap-2">
        {isExploring ? (
          <Button
            variant="danger"
            fullWidth
            icon={<Square size={11} />}
            onClick={store.stopExploration}
          >
            Stop Exploration
          </Button>
        ) : (
          <Button
            variant="primary"
            fullWidth
            icon={<Play size={11} />}
            onClick={store.startExploration}
          >
            Start Exploration
          </Button>
        )}
      </div>

      {showProgress && (
        <div className="p-3 bg-surface-2 border border-border rounded-lg space-y-2">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <div className="text-sm font-bold text-text-primary">{progress.pagesVisited}</div>
              <div className="text-2xs text-text-muted">Pages</div>
            </div>
            <div>
              <div className="text-sm font-bold text-text-primary">{progress.elementsFound}</div>
              <div className="text-2xs text-text-muted">Elements</div>
            </div>
            <div>
              <div className="text-sm font-bold text-text-primary">{progress.edgesRecorded}</div>
              <div className="text-2xs text-text-muted">Flows</div>
            </div>
          </div>
          {progress.currentPage && (
            <p className="text-2xs text-text-muted truncate text-center">
              → {progress.currentPage}
            </p>
          )}
        </div>
      )}

      <Button
        variant="secondary"
        fullWidth
        icon={isLearningFlows ? <Loader2 size={11} className="animate-spin" /> : <GitBranch size={11} />}
        onClick={store.learnFlows}
        disabled={isLearningFlows || isExploring}
      >
        {isLearningFlows ? 'Learning Flows...' : 'Learn Flows from Exploration'}
      </Button>
    </div>
  );
}
