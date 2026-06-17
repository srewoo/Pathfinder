import React, { useEffect, useState } from 'react';
import { Play, Square, Loader2, Globe, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '../shared/Button';
import { useExplorerStore } from '../../stores/explorer-store';
import type { ExplorationProgress } from '../../../storage/schemas';

interface ExplorerControlsProps {
  progress: ExplorationProgress | null;
  isExploring: boolean;
  reexploringUrl: string | null;
}

type Scope = 'page' | 'here' | 'app';

const SCOPE_OPTIONS: { id: Scope; label: string; hint: string }[] = [
  { id: 'page', label: 'This page only', hint: 'Scan only the current tab URL and its tabs/modals — no link following.' },
  { id: 'here', label: 'From here outward', hint: 'Start at the current tab and crawl outward up to the selected depth.' },
  { id: 'app', label: 'Whole app', hint: "Start at the app's landing page and crawl outward up to the selected depth." },
];

export function ExplorerControls({ progress, isExploring, reexploringUrl }: ExplorerControlsProps) {
  const store = useExplorerStore();
  const [currentTabUrl, setCurrentTabUrl] = useState<string>('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Show user which page will be used as the exploration starting point
  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      setCurrentTabUrl(tabs[0]?.url ?? '');
    });
  }, [isExploring]);

  let startLabel: string;
  try {
    startLabel = currentTabUrl ? new URL(currentTabUrl).hostname + new URL(currentTabUrl).pathname : '...';
  } catch {
    startLabel = currentTabUrl;
  }

  const scope: Scope = store.singlePageStrict ? 'page' : store.singlePageOnly ? 'here' : 'app';
  const setScope = (s: Scope) => {
    if (s === 'page') store.setSinglePageStrict(true);
    else if (s === 'here') store.setSinglePageOnly(true);
    else { store.setSinglePageStrict(false); store.setSinglePageOnly(false); }
  };

  const showProgress = progress && (isExploring || progress.status === 'running');
  const depthApplies = scope !== 'page';

  return (
    <div className="space-y-3">
      {/* Scope — one segmented control replaces the old pair of confusable toggles */}
      {!reexploringUrl && (
        <div>
          <label className="block text-2xs font-medium text-text-muted mb-1">Exploration scope</label>
          <div className="grid grid-cols-3 gap-1 p-0.5 bg-surface-2 border border-border rounded-lg">
            {SCOPE_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                disabled={isExploring}
                onClick={() => setScope(opt.id)}
                className={[
                  'px-1.5 py-1.5 rounded-md text-2xs font-medium transition-colors leading-tight',
                  scope === opt.id ? 'bg-primary text-white' : 'text-text-muted hover:text-text-secondary',
                  'disabled:opacity-50',
                ].join(' ')}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p className="text-2xs text-text-muted mt-1">{SCOPE_OPTIONS.find((o) => o.id === scope)?.hint}</p>
        </div>
      )}

      {/* Depth — applies to "from here" and "whole app" (irrelevant for single page) */}
      {!reexploringUrl && depthApplies && (
        <div>
          <label className="block text-2xs font-medium text-text-muted mb-1">Exploration depth</label>
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
          <p className="text-2xs text-text-muted mt-1">Higher depth discovers more pages but takes longer.</p>
        </div>
      )}

      {/* Advanced options — collapsed by default to cut first-run cognitive load */}
      {!reexploringUrl && (
        <div className="bg-surface-2 border border-border rounded-lg">
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="w-full flex items-center justify-between px-2.5 py-2 text-2xs font-medium text-text-secondary"
          >
            <span>Advanced options</span>
            {showAdvanced ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>

          {showAdvanced && (
            <div className="px-2.5 pb-2.5 space-y-3 border-t border-border pt-2.5">
              {/* Submit forms — read-only by default; opt-in mutates the live app */}
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <label htmlFor="submit-forms-toggle" className="block text-2xs font-medium text-text-primary cursor-pointer">
                    Submit forms (writes to app)
                  </label>
                  <p className="text-2xs text-text-muted mt-0.5">
                    Off by default. When on, the explorer fills and submits forms with test data — only use on a sandbox account.
                  </p>
                </div>
                <Toggle
                  id="submit-forms-toggle"
                  checked={store.submitForms}
                  disabled={isExploring}
                  onToggle={() => store.setSubmitForms(!store.submitForms)}
                  color="warning"
                />
              </div>

              {/* Re-scan everything — not applicable to strict single-page */}
              {scope !== 'page' && (
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <label htmlFor="fresh-rescan-toggle" className="block text-2xs font-medium text-text-primary cursor-pointer">
                      Re-scan everything (refresh map)
                    </label>
                    <p className="text-2xs text-text-muted mt-0.5">
                      Re-visits pages already mapped (picks up changes) and removes pages no longer reachable. Off = only add newly-found pages. A snapshot is saved before any removal.
                    </p>
                  </div>
                  <Toggle
                    id="fresh-rescan-toggle"
                    checked={store.freshRescan}
                    disabled={isExploring}
                    onToggle={() => store.setFreshRescan(!store.freshRescan)}
                    color="primary"
                  />
                </div>
              )}
            </div>
          )}
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
          <Button variant="danger" fullWidth icon={<Square size={11} />} onClick={store.stopExploration}>
            Stop Exploration
          </Button>
        ) : (
          <Button variant="primary" fullWidth icon={<Play size={11} />} onClick={store.startExploration}>
            Start Exploration
          </Button>
        )}
      </div>

      {showProgress && (
        <div className="p-3 bg-surface-2 border border-border rounded-lg space-y-2">
          <div className="grid grid-cols-3 gap-2 text-center">
            <Stat value={progress.pagesVisited} label="Pages" />
            <Stat value={progress.elementsFound} label="Elements" />
            <Stat value={progress.edgesRecorded} label="Links" />
          </div>
          {progress.currentPage && (
            <p className="text-2xs text-text-muted truncate text-center">→ {progress.currentPage}</p>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <div className="text-sm font-bold text-text-primary">{value}</div>
      <div className="text-2xs text-text-muted">{label}</div>
    </div>
  );
}

function Toggle({ id, checked, disabled, onToggle, color }: {
  id: string; checked: boolean; disabled?: boolean; onToggle: () => void; color: 'primary' | 'warning';
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onToggle}
      className={[
        'relative inline-flex h-4 w-7 flex-shrink-0 items-center rounded-full transition-colors',
        checked ? (color === 'warning' ? 'bg-warning' : 'bg-primary') : 'bg-surface-3 border border-border',
        'disabled:opacity-50',
      ].join(' ')}
    >
      <span
        className={[
          'inline-block h-3 w-3 transform rounded-full bg-white transition-transform',
          checked ? 'translate-x-3.5' : 'translate-x-0.5',
        ].join(' ')}
      />
    </button>
  );
}
