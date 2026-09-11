import React from 'react';
import { Download, Trash2, BarChart2, FileText, Terminal, Activity, Film, Shield, ArrowRight, Accessibility, PlayCircle, Code2, Upload } from 'lucide-react';
import { TestReport } from './TestReport';
import { TestDashboard } from './TestDashboard';
import { ExecutionTimeline } from './ExecutionTimeline';
import { Button } from '../shared/Button';
import { useTestStore } from '../../stores/test-store';
import { useNavigationStore } from '../../stores/navigation-store';
import { generateHtmlReport } from '../../../utils/html-reporter';
import { toJUnitXml } from '../../../core/report/junit-export';
import { summarizeVerdicts } from '../../../core/report/result-adapter';
import {
  approximateTestability,
  toExportRun,
} from '../../../core/report/result-adapter';
import { formatTestabilityReport } from '../../../core/report/heal-ledger';
import { generateJsonReport } from '../../../utils/report-exporter';
import { SegmentedControl } from '../shared/SegmentedControl';
import { generateScreencastPlayer } from '../../../core/cdp/screencast';
import {
  buildPlaywrightExport,
  exportInputsFromResults,
} from '../../../core/export/playwright-export';
import { caseIdFromTestCaseId } from '../../../core/integrations/testrail-sync';
import { useSettingsStore } from '../../stores/settings-store';

type ViewMode = 'results' | 'timeline' | 'dashboard';

export function ResultsPanel() {
  const store = useTestStore();
  const goTo = useNavigationStore((s) => s.setActiveTab);
  const settings = useSettingsStore();
  const [viewMode, setViewMode] = React.useState<ViewMode>('results');
  /**
   * Steps and assertions the Playwright exporter could not represent.
   *
   * Rendered rather than logged: an export that quietly drops an assertion
   * hands the user a spec file that passes for the wrong reason.
   */
  const [exportNotice, setExportNotice] = React.useState<string[]>([]);

  React.useEffect(() => {
    store.loadAll();
  }, []);

  const { results } = store;
  // One computation, shared with the exports. Counting `result.status` here is
  // what let the dashboard and this run's own JUnit export disagree, and let a
  // review-required result sit in the number a user reads as "these are fine".
  const counts = summarizeVerdicts(results);
  const { pass: passed, needsReview, fail: failed } = counts;

  const downloadBlob = (content: string, filename: string, mimeType: string) => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportJson = () => {
    const report = generateJsonReport(results);
    downloadBlob(
      JSON.stringify(report, null, 2),
      `pathfinder-report-${Date.now()}.json`,
      'application/json'
    );
  };

  /**
   * Recordings were captured, persisted, and unwatchable — nothing ever called
   * the player.
   *
   * Downloaded rather than opened in a tab. A `blob:` URL created by an extension
   * page inherits the extension's CSP, and the player drives playback from an
   * inline `<script>`, so opening it produced only:
   *
   *   Executing inline script violates the following Content Security Policy
   *   directive 'script-src 'self' … chrome-extension://…'
   *
   * Saving it means the browser opens it from `file:`, where the page's own script
   * runs — and it matches how every other export on this toolbar behaves.
   *
   * Not embedded in the HTML report either: frames are base64 PNGs, and inlining
   * them would add megabytes to every export whether or not anyone watches.
   */
  /** Results that came from a TestRail import, and so can be pushed back. */
  const hasTestRailCases = results.some((r) => caseIdFromTestCaseId(r.testCaseId) !== undefined);
  const lastRunId = settings.testrail?.lastRunId;

  const recorded = results.filter((r) => (r.screencastFrames?.length ?? 0) > 0);
  const handleWatchRecording = () => {
    const latest = recorded[0];
    if (!latest?.screencastFrames) return;
    downloadBlob(
      generateScreencastPlayer(latest.screencastFrames, latest.testCaseTitle),
      `pathfinder-recording-${latest.testCaseTitle.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.html`,
      'text/html'
    );
  };

  const handleExportHtml = () => {
    downloadBlob(
      generateHtmlReport(results),
      `pathfinder-report-${Date.now()}.html`,
      'text/html'
    );
  };

  const handleExportJUnit = () => {
    // §11 exporter: carries the NEEDS_REVIEW verdict, per-step heal records and
    // testability context that the previous generator dropped.
    downloadBlob(
      toJUnitXml(toExportRun(results, { testability: approximateTestability(results) })),
      `pathfinder-junit-${Date.now()}.xml`,
      'application/xml'
    );
  };

  const handleExportPlaywright = () => {
    const { source, dropped } = buildPlaywrightExport(
      exportInputsFromResults(results, store.testCases)
    );
    downloadBlob(source, `pathfinder-tests-${Date.now()}.spec.ts`, 'text/plain');
    setExportNotice(dropped);
  };

  /**
   * Push these results back to a TestRail run.
   *
   * Only offered when at least one result maps to a TestRail case — a button
   * that can only report "nothing was mapped" is noise.
   */
  const handlePushToTestRail = async () => {
    const runId = Number(
      window.prompt('TestRail run id to push these results to:', String(lastRunId ?? '')) ?? ''
    );
    if (!Number.isFinite(runId) || runId <= 0) return;
    await store.pushResultsToTestRail(runId);
  };

  const handleExportTestability = () => {
    // §5: which elements lack stable identifiers is actionable output for the
    // team that owns the app, not a Pathfinder failure report.
    downloadBlob(
      formatTestabilityReport(approximateTestability(results)),
      `pathfinder-testability-${Date.now()}.txt`,
      'text/plain'
    );
  };

  if (results.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 py-12 text-center px-4">
        <BarChart2 size={32} className="text-text-muted mb-3" />
        <p className="text-xs font-medium text-text-secondary">No results yet</p>
        <p className="text-2xs text-text-muted mt-1">
          Run tests from the Tests tab to see results here
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xs font-semibold text-text-primary">Test Results</h2>
          <p className="text-2xs text-text-muted mt-0.5">
            {passed} passed{needsReview > 0 ? ` · ${needsReview} need review` : ''} · {failed} failed ·{' '}
            {results.length} total
          </p>
        </div>
        <div className="flex items-center gap-1">
          {recorded.length > 0 && (
            <Button
              variant="ghost"
              size="xs"
              icon={<PlayCircle size={11} />}
              onClick={handleWatchRecording}
              title={`Download the screen recording of "${recorded[0].testCaseTitle}"`}
            />
          )}
          <Button
            variant="ghost"
            size="xs"
            icon={<FileText size={11} />}
            onClick={handleExportHtml}
            title="Export HTML report"
          />
          <Button
            variant="ghost"
            size="xs"
            icon={<Terminal size={11} />}
            onClick={handleExportJUnit}
            title="Export JUnit XML (for CI)"
          />
          <Button
            variant="ghost"
            size="xs"
            icon={<Download size={11} />}
            onClick={handleExportJson}
            title="Export JSON report"
          />
          {hasTestRailCases && (
            <Button
              variant="ghost"
              size="xs"
              icon={<Upload size={11} />}
              onClick={handlePushToTestRail}
              title="Push these results to TestRail (status, timing and failure screenshots)"
            />
          )}
          <Button
            variant="ghost"
            size="xs"
            icon={<Code2 size={11} />}
            onClick={handleExportPlaywright}
            title="Export as a Playwright spec file (runnable in CI)"
          />
          <Button
            variant="ghost"
            size="xs"
            icon={<Accessibility size={11} />}
            onClick={handleExportTestability}
            title="Export testability report (elements lacking stable test ids)"
          />
          <Button
            variant="ghost"
            size="xs"
            icon={<Trash2 size={11} />}
            onClick={store.clearResults}
            title="Clear results"
          />
        </div>
      </div>

      {/* What the Playwright export could not represent. Shown, never logged:
          a spec file missing an assertion still passes, so a silent drop is the
          one failure mode this export must not have. */}
      {exportNotice.length > 0 && (
        <div className="p-2.5 bg-warning/10 border border-warning/30 rounded-lg">
          <div className="flex items-start justify-between gap-2">
            <p className="text-2xs font-medium text-warning-text">
              {exportNotice.length} item(s) could not be exported to Playwright — verify these in
              Pathfinder:
            </p>
            <button
              type="button"
              onClick={() => setExportNotice([])}
              className="text-2xs text-text-muted hover:text-text-primary flex-shrink-0"
            >
              Dismiss
            </button>
          </div>
          <ul className="mt-1.5 space-y-0.5">
            {exportNotice.slice(0, 8).map((reason, i) => (
              <li key={i} className="text-2xs text-text-secondary">
                • {reason}
              </li>
            ))}
            {exportNotice.length > 8 && (
              <li className="text-2xs text-text-muted">
                … and {exportNotice.length - 8} more
              </li>
            )}
          </ul>
        </div>
      )}

      {/* Outcome of the last TestRail import or push. Partial pushes list every
          case that did not land — a silent partial sync is the worst outcome. */}
      {store.testRailStatus && (
        <div className="p-2.5 bg-surface-2 border border-border rounded-lg">
          <div className="flex items-start justify-between gap-2">
            <p className="text-2xs text-text-primary">{store.testRailStatus.message}</p>
            <button
              type="button"
              onClick={() => useTestStore.setState({ testRailStatus: null })}
              className="text-2xs text-text-muted hover:text-text-primary flex-shrink-0"
            >
              Dismiss
            </button>
          </div>
          {store.testRailStatus.failures.length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {store.testRailStatus.failures.slice(0, 8).map((f, i) => (
                <li key={i} className="text-2xs text-error-text">
                  • {f}
                </li>
              ))}
              {store.testRailStatus.failures.length > 8 && (
                <li className="text-2xs text-text-muted">
                  … and {store.testRailStatus.failures.length - 8} more
                </li>
              )}
            </ul>
          )}
        </div>
      )}

      {/* Summary stats */}
      <div className="grid grid-cols-4 gap-2 p-3 bg-surface-2 border border-border rounded-lg">
        <div className="text-center">
          <div className="text-lg font-bold text-success-text">{passed}</div>
          <div className="text-2xs text-text-muted">Passed</div>
        </div>
        <div
          className="text-center border-l border-border"
          title="Passed, but something needs a human look — healed locators, or an oracle finding the test did not check for."
        >
          <div className={`text-lg font-bold ${needsReview > 0 ? 'text-warning-text' : 'text-text-muted'}`}>
            {needsReview}
          </div>
          <div className="text-2xs text-text-muted">Review</div>
        </div>
        <div className="text-center border-x border-border">
          <div className="text-lg font-bold text-error-text">{failed}</div>
          <div className="text-2xs text-text-muted">Failed</div>
        </div>
        <div className="text-center">
          <div className="text-lg font-bold text-text-secondary">{results.length}</div>
          <div className="text-2xs text-text-muted">Total</div>
        </div>
      </div>

      {/* Hand-off to the final stage — coverage/contract analysis of this run */}
      <button
        type="button"
        onClick={() => goTo('analysis')}
        className="flex items-center justify-between gap-2 px-2.5 py-2 bg-surface-2 border border-border rounded-lg hover:border-border-light transition-colors text-left"
      >
        <span className="flex items-center gap-2 min-w-0">
          <Shield size={12} className="text-primary-text flex-shrink-0" />
          <span className="text-xs text-text-primary truncate">Analyze API coverage, accessibility & contracts</span>
        </span>
        <span className="flex items-center gap-1 text-2xs text-text-muted flex-shrink-0">
          Analysis <ArrowRight size={11} />
        </span>
      </button>

      {/* One SegmentedControl: this was a tab strip with no role, no aria-selected
          and no keyboard navigation. */}
      <SegmentedControl
        options={[
          { id: 'results', icon: FileText, label: 'Results' },
          { id: 'timeline', icon: Film, label: 'Timeline' },
          { id: 'dashboard', icon: Activity, label: 'Trends' },
        ]}
        value={viewMode}
        onChange={setViewMode}
        stacked={false}
        label="Results view"
      />

      {/* Content based on view mode */}
      {viewMode === 'results' && <TestReport results={results} />}

      {viewMode === 'timeline' && (
        <div className="flex flex-col gap-2">
          {results.map((r) => (
            <ExecutionTimeline key={r.id} result={r} />
          ))}
        </div>
      )}

      {viewMode === 'dashboard' && <TestDashboard />}
    </div>
  );
}
