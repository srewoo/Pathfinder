import { useEffect, useState } from "react";
import { Play, Square, Loader2, Globe, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '../shared/Button';
import { SegmentedControl } from '../shared/SegmentedControl';
import { useExplorerStore } from '../../stores/explorer-store';
import type { ExplorationProgress, ExplorationCoverage } from '../../../storage/schemas';

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
          <SegmentedControl
            options={SCOPE_OPTIONS.map((opt) => ({
              id: opt.id,
              label: opt.label,
              title: opt.hint,
              disabled: isExploring,
            }))}
            value={scope}
            onChange={setScope}
            stacked={false}
            label="Exploration scope"
          />
          <p className="text-2xs text-text-muted mt-1">{SCOPE_OPTIONS.find((o) => o.id === scope)?.hint}</p>
        </div>
      )}

      {/* Depth — applies to "from here" and "whole app" (irrelevant for single page) */}
      {!reexploringUrl && depthApplies && (
        <div>
          <label className="block text-2xs font-medium text-text-muted mb-1">Exploration depth</label>
          <SegmentedControl
            options={[1, 2, 3, 4, 5].map((d) => ({
              id: String(d) as '1' | '2' | '3' | '4' | '5',
              label: String(d),
              title: `Explore ${d} level(s) deep`,
              disabled: isExploring,
            }))}
            value={String(store.explorationDepth) as '1' | '2' | '3' | '4' | '5'}
            onChange={(d) => store.setDepth(Number(d))}
            stacked={false}
            label="Exploration depth"
          />
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
          {progress.coverage && (
            <CoverageBar coverage={progress.coverage} />
          )}
          {progress.currentPage && (
            <p className="text-2xs text-text-muted truncate text-center">→ {progress.currentPage}</p>
          )}
        </div>
      )}

      {/* Last-run coverage summary — persists after the run finishes so the user
          sees what was (and wasn't) covered, not just raw visit counts. */}
      {!isExploring && !showProgress && store.coverage && (
        <CoverageSummary coverage={store.coverage} />
      )}
    </div>
  );
}

function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/** Compact live coverage strip shown under the running progress stats. */
function CoverageBar({ coverage }: { coverage: ExplorationCoverage }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-2xs">
        <span className="text-text-muted">{coverage.singlePage ? 'Page mapped' : 'Coverage'}</span>
        <span className="font-semibold text-text-primary">{pct(coverage.coverageRatio)}</span>
      </div>
      <div className="h-1 w-full rounded-full bg-surface-3 overflow-hidden">
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${Math.round(coverage.coverageRatio * 100)}%` }}
        />
      </div>
      <div className="flex items-center justify-center gap-3 text-2xs text-text-muted">
        {coverage.pagesFailed > 0 && <span className="text-warning-text">{coverage.pagesFailed} failed</span>}
        {coverage.untestedPaths > 0 && (
          <span>{coverage.untestedPaths} {coverage.singlePage ? 'links found' : 'untested'}</span>
        )}
        {coverage.brokenLinks > 0 && <span className="text-danger">{coverage.brokenLinks} broken</span>}
      </div>
    </div>
  );
}

/** Post-run coverage/health card with warnings. Scope-aware: a single-page run
 *  reports the anchored page as its whole scope (100% when clean) and treats the
 *  links it discovered as next-step hints rather than coverage gaps. */
function CoverageSummary({ coverage }: { coverage: ExplorationCoverage }) {
  const [showWarnings, setShowWarnings] = useState(false);
  const clean = coverage.pagesFailed === 0 && coverage.brokenLinks === 0 && coverage.warnings.length === 0;
  const { singlePage } = coverage;
  return (
    <div className="p-3 bg-surface-2 border border-border rounded-lg space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-2xs font-medium text-text-secondary">
          {singlePage ? 'Last run — this page' : `Last run coverage${coverage.complete ? '' : ' (partial)'}`}
        </span>
        <span className="text-sm font-bold text-text-primary">{pct(coverage.coverageRatio)}</span>
      </div>
      <div className="h-1 w-full rounded-full bg-surface-3 overflow-hidden">
        <div className="h-full bg-primary" style={{ width: `${Math.round(coverage.coverageRatio * 100)}%` }} />
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-2xs text-text-muted">
        <span>{coverage.pagesScanned} page{coverage.pagesScanned === 1 ? '' : 's'} mapped</span>
        {singlePage ? (
          <span className={coverage.untestedPaths > 0 ? 'text-text-secondary' : ''}>{coverage.untestedPaths} link{coverage.untestedPaths === 1 ? '' : 's'} to explore</span>
        ) : (
          <span className={coverage.untestedPaths > 0 ? 'text-text-secondary' : ''}>{coverage.untestedPaths} untested path{coverage.untestedPaths === 1 ? '' : 's'}</span>
        )}
        <span className={coverage.pagesFailed > 0 ? 'text-warning-text' : ''}>{coverage.pagesFailed} scan failure{coverage.pagesFailed === 1 ? '' : 's'}</span>
        <span className={coverage.brokenLinks > 0 ? 'text-danger' : ''}>{coverage.brokenLinks} broken link{coverage.brokenLinks === 1 ? '' : 's'}</span>
      </div>
      {clean && singlePage && coverage.untestedPaths > 0 && (
        <p className="text-2xs text-text-muted">This page was mapped fully. Switch scope to “From here outward” to explore the {coverage.untestedPaths} link{coverage.untestedPaths === 1 ? '' : 's'} it found.</p>
      )}
      {clean && singlePage && coverage.untestedPaths === 0 && (
        <p className="text-2xs text-success-text">✓ Clean run — this page was mapped fully.</p>
      )}
      {clean && !singlePage && <p className="text-2xs text-success-text">✓ Clean run — everything discovered was mapped.</p>}
      {coverage.warnings.length > 0 && (
        <div className="border-t border-border pt-1.5">
          <button
            type="button"
            onClick={() => setShowWarnings((v) => !v)}
            className="flex items-center gap-1 text-2xs font-medium text-warning-text"
          >
            {showWarnings ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            {coverage.warnings.length} warning{coverage.warnings.length === 1 ? '' : 's'}
          </button>
          {showWarnings && (
            <ul className="mt-1 space-y-0.5 max-h-32 overflow-y-auto">
              {coverage.warnings.map((w, i) => (
                <li key={i} className="text-2xs text-text-muted font-mono break-all leading-tight">• {w}</li>
              ))}
            </ul>
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
