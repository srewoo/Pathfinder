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
      {/* Strict single-page toggle — scan ONLY this page, no link following */}
      {!reexploringUrl && (
        <div className="flex items-start justify-between gap-3 px-2.5 py-2 bg-surface-2 border border-border rounded-lg">
          <div className="flex-1 min-w-0">
            <label htmlFor="single-page-strict-toggle" className="block text-2xs font-medium text-text-primary cursor-pointer">
              Single page only
            </label>
            <p className="text-2xs text-text-muted mt-0.5">
              Scan only the current tab URL and its components (tabs, modals) — no link following.
            </p>
          </div>
          <button
            id="single-page-strict-toggle"
            type="button"
            role="switch"
            aria-checked={store.singlePageStrict}
            disabled={isExploring}
            onClick={() => store.setSinglePageStrict(!store.singlePageStrict)}
            className={[
              'relative inline-flex h-4 w-7 flex-shrink-0 items-center rounded-full transition-colors',
              store.singlePageStrict ? 'bg-primary' : 'bg-surface-3 border border-border',
              'disabled:opacity-50',
            ].join(' ')}
          >
            <span
              className={[
                'inline-block h-3 w-3 transform rounded-full bg-white transition-transform',
                store.singlePageStrict ? 'translate-x-3.5' : 'translate-x-0.5',
              ].join(' ')}
            />
          </button>
        </div>
      )}

      {/* "Start from this page" — crawl outward from the current tab to depth */}
      {!reexploringUrl && (
        <div className="flex items-start justify-between gap-3 px-2.5 py-2 bg-surface-2 border border-border rounded-lg">
          <div className="flex-1 min-w-0">
            <label htmlFor="single-page-toggle" className="block text-2xs font-medium text-text-primary cursor-pointer">
              Start from this page
            </label>
            <p className="text-2xs text-text-muted mt-0.5">
              Begin exploration at the current tab and crawl outward up to the selected depth (instead of the app's landing page).
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

      {/* Submit-forms toggle — read-only by default; opt-in mutates the live app */}
      {!reexploringUrl && (
        <div className="flex items-start justify-between gap-3 px-2.5 py-2 bg-surface-2 border border-border rounded-lg">
          <div className="flex-1 min-w-0">
            <label htmlFor="submit-forms-toggle" className="block text-2xs font-medium text-text-primary cursor-pointer">
              Submit forms (writes to app)
            </label>
            <p className="text-2xs text-text-muted mt-0.5">
              Off by default. When on, the explorer fills and submits forms with test data — only use on a sandbox account.
            </p>
          </div>
          <button
            id="submit-forms-toggle"
            type="button"
            role="switch"
            aria-checked={store.submitForms}
            disabled={isExploring}
            onClick={() => store.setSubmitForms(!store.submitForms)}
            className={[
              'relative inline-flex h-4 w-7 flex-shrink-0 items-center rounded-full transition-colors',
              store.submitForms ? 'bg-warning' : 'bg-surface-3 border border-border',
              'disabled:opacity-50',
            ].join(' ')}
          >
            <span
              className={[
                'inline-block h-3 w-3 transform rounded-full bg-white transition-transform',
                store.submitForms ? 'translate-x-3.5' : 'translate-x-0.5',
              ].join(' ')}
            />
          </button>
        </div>
      )}

      {/* Fresh re-scan toggle — re-visit existing pages + prune dead ones.
          Not applicable to strict single-page (only one page is touched). */}
      {!reexploringUrl && !store.singlePageStrict && (
        <div className="flex items-start justify-between gap-3 px-2.5 py-2 bg-surface-2 border border-border rounded-lg">
          <div className="flex-1 min-w-0">
            <label htmlFor="fresh-rescan-toggle" className="block text-2xs font-medium text-text-primary cursor-pointer">
              Re-scan everything (refresh map)
            </label>
            <p className="text-2xs text-text-muted mt-0.5">
              Re-visits pages already mapped (picks up changes) and removes pages no longer reachable. Off = only add newly-found pages. A snapshot is saved before any removal.
            </p>
          </div>
          <button
            id="fresh-rescan-toggle"
            type="button"
            role="switch"
            aria-checked={store.freshRescan}
            disabled={isExploring}
            onClick={() => store.setFreshRescan(!store.freshRescan)}
            className={[
              'relative inline-flex h-4 w-7 flex-shrink-0 items-center rounded-full transition-colors',
              store.freshRescan ? 'bg-primary' : 'bg-surface-3 border border-border',
              'disabled:opacity-50',
            ].join(' ')}
          >
            <span
              className={[
                'inline-block h-3 w-3 transform rounded-full bg-white transition-transform',
                store.freshRescan ? 'translate-x-3.5' : 'translate-x-0.5',
              ].join(' ')}
            />
          </button>
        </div>
      )}

      {/* Depth selector — applies to full and start-from-this-page crawls
          (irrelevant for strict single-page, which is depth 0). */}
      {!reexploringUrl && !store.singlePageStrict && (
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
