import React from 'react';
import { Download, Trash2, BarChart2, FileText, Terminal, Activity, Film } from 'lucide-react';
import { TestReport } from './TestReport';
import { TestDashboard } from './TestDashboard';
import { ExecutionTimeline } from './ExecutionTimeline';
import { Button } from '../shared/Button';
import { useTestStore } from '../../stores/test-store';
import { generateHtmlReport, generateJUnitXml } from '../../../utils/html-reporter';
import { generateJsonReport } from '../../../utils/report-exporter';

type ViewMode = 'results' | 'timeline' | 'dashboard';

export function ResultsPanel() {
  const store = useTestStore();
  const [viewMode, setViewMode] = React.useState<ViewMode>('results');

  React.useEffect(() => {
    store.loadAll();
  }, []);

  const { results } = store;
  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => r.status === 'failed' || r.status === 'error').length;

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

  const handleExportHtml = () => {
    downloadBlob(
      generateHtmlReport(results),
      `pathfinder-report-${Date.now()}.html`,
      'text/html'
    );
  };

  const handleExportJUnit = () => {
    downloadBlob(
      generateJUnitXml(results),
      `pathfinder-junit-${Date.now()}.xml`,
      'application/xml'
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
            {passed} passed · {failed} failed · {results.length} total
          </p>
        </div>
        <div className="flex items-center gap-1">
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
          <Button
            variant="ghost"
            size="xs"
            icon={<Trash2 size={11} />}
            onClick={store.clearResults}
            title="Clear results"
          />
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-2 p-3 bg-surface-2 border border-border rounded-lg">
        <div className="text-center">
          <div className="text-lg font-bold text-success">{passed}</div>
          <div className="text-2xs text-text-muted">Passed</div>
        </div>
        <div className="text-center border-x border-border">
          <div className="text-lg font-bold text-error">{failed}</div>
          <div className="text-2xs text-text-muted">Failed</div>
        </div>
        <div className="text-center">
          <div className="text-lg font-bold text-text-secondary">{results.length}</div>
          <div className="text-2xs text-text-muted">Total</div>
        </div>
      </div>

      {/* View mode tabs */}
      <div className="flex gap-1 bg-surface-2 p-0.5 rounded-lg border border-border">
        <ViewTab
          active={viewMode === 'results'}
          onClick={() => setViewMode('results')}
          icon={<FileText size={10} />}
          label="Results"
        />
        <ViewTab
          active={viewMode === 'timeline'}
          onClick={() => setViewMode('timeline')}
          icon={<Film size={10} />}
          label="Timeline"
        />
        <ViewTab
          active={viewMode === 'dashboard'}
          onClick={() => setViewMode('dashboard')}
          icon={<Activity size={10} />}
          label="Trends"
        />
      </div>

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

function ViewTab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        'flex-1 flex items-center justify-center gap-1 py-1.5 rounded-md text-2xs font-medium transition-colors',
        active
          ? 'bg-primary text-white shadow-sm'
          : 'text-text-muted hover:text-text-secondary hover:bg-surface-3',
      ].join(' ')}
    >
      {icon}
      {label}
    </button>
  );
}
