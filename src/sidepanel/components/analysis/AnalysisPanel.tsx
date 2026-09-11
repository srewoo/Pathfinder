import React, { useEffect, useRef, useState } from 'react';
import { Shield, Activity, Eye, FileCheck, AlertTriangle, DollarSign } from 'lucide-react';
import { Button } from '../shared/Button';
import { SegmentedControl } from '../shared/SegmentedControl';
import { sendToBackground } from '../../../messaging/messenger';
import { useTestStore } from '../../stores/test-store';
import { useAnalysisStore, type AnalysisSection } from '../../stores/analysis-store';

/** No report after this long → surface a failure instead of spinning forever. */
const ANALYSIS_TIMEOUT_MS = 90_000;

export function AnalysisPanel() {
  const [active, setActive] = useState<AnalysisSection>('coverage');
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * Errors from the baseline buttons, which answer synchronously and produce no
   * report. Kept apart from job state so a baseline failure does not present as
   * the analysis having failed.
   */
  const [actionError, setActionError] = useState<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const results = useTestStore((s) => s.results);
  const resultCount = results.length;

  // Reports and job state live in the store, which App owns. Keeping them here
  // meant a tab switch destroyed both the report and the listener waiting for it.
  const reports = useAnalysisStore((s) => s.reports);
  const jobs = useAnalysisStore((s) => s.jobs);
  const beginRequest = useAnalysisStore((s) => s.beginRequest);
  const failJob = useAnalysisStore((s) => s.failJob);
  const timeoutJob = useAnalysisStore((s) => s.timeoutJob);

  const job = jobs[active];
  const loading = job.status === 'running';
  const error =
    job.status === 'failed'
      ? job.reason
      : job.status === 'timeout'
        ? 'Analysis timed out with no result. Check that the app tab is open, and for coverage or contracts that a run has produced captured traffic.'
        : null;

  /**
   * The report to show for the section in view.
   *
   * Scope-keyed, so a report computed for a different app or run is not
   * displayed as this one's. When nothing matches the current scope, the most
   * recent report of that type is shown and labelled with what it describes —
   * hiding it would throw away work the user already paid for.
   */
  const currentRunId = results[0]?.runId;
  const report = (() => {
    const ofType = Object.values(reports).filter((r) => r.type === active);
    if (ofType.length === 0) return undefined;
    const matching = ofType.find((r) => !r.scope.runId || r.scope.runId === currentRunId);
    return (
      matching ??
      [...ofType].sort((a, b) => b.completedAt.localeCompare(a.completedAt))[0]
    );
  })();
  const stale = report !== undefined && !!report.scope.runId && report.scope.runId !== currentRunId;

  const clearTimer = () => {
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
  };

  useEffect(() => clearTimer, []);

  const runAnalysis = async (type: AnalysisSection) => {
    setActive(type);
    clearTimer();
    const requestId = beginRequest(type);
    // The timeout marks only a job that is still running, so a result that
    // arrived while the panel was closed cannot be retroactively timed out.
    timeoutRef.current = setTimeout(() => timeoutJob(type), ANALYSIS_TIMEOUT_MS);
    try {
      const messageType = type === 'coverage' ? 'GET_HAR_IMPACT'
        : type === 'a11y' ? 'RUN_A11Y_AUDIT'
        : type === 'cost' ? 'GET_COST_REPORT'
        : 'VALIDATE_API_CONTRACTS';
      // The response matters. Every handler answers a precondition failure with
      // `{ success: false, error }` and sends no broadcast — and this call used to
      // discard that answer, so a run that failed in milliseconds ("No OpenAPI spec
      // loaded", "No HAR entries captured") sat on "Running…" for the full timeout
      // and then blamed a timeout. The reason was always right there in the reply.
      const response = await sendToBackground<{ success?: boolean; error?: string } | undefined>(
        // The requestId travels with the request and comes back on the report,
        // so a slow answer to a superseded question cannot be shown as current.
        { type: messageType, payload: { requestId } } as never
      );
      if (response && response.success === false) {
        clearTimer();
        failJob(type, response.error ?? 'Analysis could not run.');
        return;
      }
    } catch (err) {
      clearTimer();
      failJob(type, err instanceof Error ? err.message : 'Failed to start analysis.');
    }
  };

  /**
   * Baseline capture/clear answer synchronously — there is no report to wait for, so
   * these do NOT go through the broadcast path that `runAnalysis` uses.
   */
  const runBaselineAction = async (type: 'CAPTURE_API_BASELINE' | 'CLEAR_API_BASELINE', ok: string) => {
    setActionError(null);
    setNotice(null);
    try {
      const response = await sendToBackground<{ success?: boolean; error?: string; summary?: { endpoints: number } } | undefined>(
        { type } as never
      );
      if (response && response.success === false) {
        setActionError(response.error ?? 'Could not complete that.');
        return;
      }
      const n = response?.summary?.endpoints;
      setNotice(n !== undefined ? `${ok} ${n} endpoint(s) recorded.` : ok);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not complete that.');
    }
  };

  const currentReport = report;

  const sections: Array<{ id: AnalysisSection; icon: React.ElementType; label: string; description: string; needsRun: boolean }> = [
    // "tested vs untested" is the binary framing the report no longer uses: an
    // endpoint a test called and nothing checked is neither.
    { id: 'coverage', icon: Activity, label: 'API Coverage', description: 'Which endpoints are verified, merely called, or never driven', needsRun: true },
    { id: 'a11y', icon: Eye, label: 'Accessibility', description: 'WCAG issues found via the CDP accessibility tree', needsRun: false },
    { id: 'contracts', icon: FileCheck, label: 'API Contracts', description: 'Check captured API traffic; add an OpenAPI spec for schema validation', needsRun: true },
    { id: 'cost', icon: DollarSign, label: 'LLM Cost', description: 'Estimated AI spend for this session', needsRun: false },
  ];

  const activeSection = sections.find((s) => s.id === active)!;
  // Coverage and contracts read network traffic captured while tests ran, so the
  // prerequisite is captured traffic — not merely that some result exists
  // somewhere. A global result count said the prerequisite was met while the
  // analysis had nothing to read, which is how "Running…" became a timeout.
  const haveCapturedTraffic = results.some((r) => (r.harEntries?.length ?? 0) > 0);
  const missingPrereq = activeSection.needsRun && (resultCount === 0 || !haveCapturedTraffic);

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center gap-2 mb-2">
        <Shield size={16} className="text-primary" />
        <h2 className="text-sm font-semibold">Analysis</h2>
      </div>

      {/* One SegmentedControl — this strip previously had no role, no
          aria-selected and no keyboard navigation. */}
      <SegmentedControl
        options={sections.map((sec) => ({ id: sec.id, icon: sec.icon, label: sec.label, title: sec.description }))}
        value={active}
        onChange={(id) => { setActive(id); setActionError(null); setNotice(null); }}
        label="Analysis type"
      />

      <p className="text-2xs text-text-muted">{activeSection.description}</p>

      {/* Baseline controls — only meaningful for the contracts view. */}
      {active === 'contracts' && (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void runBaselineAction('CAPTURE_API_BASELINE', 'Baseline captured.')}
            disabled={loading}
            className="flex-1"
            title="Record the API shapes from the last run as the baseline to compare future runs against"
          >
            Capture baseline
          </Button>
          <Button
            size="sm"
            variant="danger-quiet"
            onClick={() => void runBaselineAction('CLEAR_API_BASELINE', 'Baseline cleared.')}
            disabled={loading}
            title="Forget the stored baseline for this app"
          >
            Clear
          </Button>
        </div>
      )}
      {notice && <p className="text-2xs text-success-text">{notice}</p>}

      {/* Precondition hint — coverage/contracts need executed-test traffic */}
      {missingPrereq && (
        <div className="flex items-start gap-2 p-2.5 bg-warning/10 border border-warning/30 rounded-lg">
          <AlertTriangle size={12} className="text-warning-text flex-shrink-0 mt-0.5" />
          <p className="text-2xs text-warning-text leading-relaxed">
            {resultCount === 0
              ? 'This analysis uses network traffic captured while tests run. Run some tests on the Tests tab first, then come back.'
              : 'Your runs recorded no network traffic, so there is nothing for this analysis to read. Re-run with CDP capture active.'}
          </p>
        </div>
      )}

      <Button variant="primary" onClick={() => runAnalysis(active)} disabled={loading} fullWidth>
        {loading ? 'Running…' : `Run ${activeSection.label} Analysis`}
      </Button>

      {/* Error state — previously this stage failed silently */}
      {(error || actionError) && (
        <div className="flex items-start gap-2 p-2.5 bg-error/10 border border-error/30 rounded-lg">
          <AlertTriangle size={12} className="text-error-text flex-shrink-0 mt-0.5" />
          <p className="text-2xs text-error-text leading-relaxed">{error ?? actionError}</p>
        </div>
      )}

      {/* Report output */}
      {currentReport ? (
        <div className="mt-2">
          <div className="flex flex-wrap justify-between items-center gap-1 mb-2">
            <span className="text-2xs text-text-muted">
              {new Date(currentReport.completedAt).toLocaleString()}
              {currentReport.scope.runId ? ` · run ${currentReport.scope.runId.slice(0, 8)}` : ''}
              {currentReport.scope.pageUrl ? ` · ${shortenForLabel(currentReport.scope.pageUrl)}` : ''}
            </span>
          </div>
          {stale && (
            // A report from an earlier run is still worth showing, but reading
            // it as current would be the same class of error this task fixes.
            <p className="text-2xs text-warning-text mb-2">
              This report is from an earlier run. Re-run the analysis to describe the latest results.
            </p>
          )}
          {active === 'a11y' && (
            // Stated on the report, so it is not read as a compliance verdict.
            <p className="text-2xs text-text-muted mb-2">
              A limited rule set read from the accessibility tree — not a full WCAG audit.
            </p>
          )}
          <div className="bg-surface-1 border border-border rounded-lg p-3 overflow-y-auto max-h-[420px]">
            <MarkdownLite source={currentReport.markdown} />
          </div>
        </div>
      ) : !error && (
        <div className="text-center text-text-muted text-xs py-8">
          No report yet. Run an analysis to see results.
        </div>
      )}
    </div>
  );
}

/**
 * Minimal markdown renderer — enough to make analysis reports readable without
 * pulling in a full markdown dependency.
 *
 * Tables are the reason this exists in this shape: every report leaned on them and
 * they rendered as raw pipes, so the most information-dense part of each report was
 * the least readable part of the panel.
 */
function MarkdownLite({ source }: { source: string }) {
  const blocks = parseBlocks(source.split('\n'));
  return (
    <div className="space-y-1 text-xs leading-relaxed text-text-secondary">
      {blocks.map((block, i) =>
        block.kind === 'table' ? <MarkdownTable key={i} rows={block.rows} align={block.align} /> : (
          <React.Fragment key={i}>{block.node}</React.Fragment>
        )
      )}
    </div>
  );
}

type Align = 'left' | 'right' | 'center';
type Block =
  | { kind: 'table'; rows: string[][]; align: Align[] }
  | { kind: 'line'; node: React.ReactNode };

const isTableRow = (line: string): boolean => line.trim().startsWith('|') && line.trim().endsWith('|');
const isSeparator = (line: string): boolean => /^\|[\s:|-]+\|$/.test(line.trim()) && line.includes('-');

const splitRow = (line: string): string[] =>
  line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

function alignmentsFrom(separator: string): Align[] {
  return splitRow(separator).map((cell) => {
    const right = cell.endsWith(':');
    const left = cell.startsWith(':');
    if (right && left) return 'center';
    return right ? 'right' : 'left';
  });
}

/** Group lines into tables and everything else. */
function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    // A table is a header row, a separator, then rows — anything less is just text.
    if (isTableRow(lines[i]) && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      const align = alignmentsFrom(lines[i + 1]);
      const rows = [splitRow(lines[i])];
      i += 2;
      while (i < lines.length && isTableRow(lines[i]) && !isSeparator(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ kind: 'table', rows, align });
      continue;
    }
    blocks.push({ kind: 'line', node: renderLine(lines[i], i) });
    i++;
  }
  return blocks;
}

function renderLine(line: string, key: number): React.ReactNode {
  const trimmed = line.trim();
  if (!trimmed) return <div className="h-1.5" />;
  if (trimmed.startsWith('> ')) {
    // Callouts carry the caveats — an unpriced model, an unverifiable claim.
    return (
      <div className="flex gap-2 px-2.5 py-2 my-1 bg-warning/10 border-l-2 border-warning rounded-r">
        <span className="text-2xs text-warning-text">{inline(trimmed.slice(2))}</span>
      </div>
    );
  }
  if (trimmed.startsWith('### ')) return <h4 className="text-2xs font-semibold text-text-primary uppercase tracking-wide mt-2">{inline(trimmed.slice(4))}</h4>;
  if (trimmed.startsWith('## ')) return <h3 className="text-xs font-bold text-text-primary mt-2">{inline(trimmed.slice(3))}</h3>;
  if (trimmed.startsWith('# ')) return <h2 className="text-sm font-bold text-text-primary mt-1">{inline(trimmed.slice(2))}</h2>;
  if (/^[-*]\s/.test(trimmed)) {
    return (
      <div className="flex gap-1.5 pl-1">
        <span className="text-primary-text">•</span>
        <span>{inline(trimmed.slice(2))}</span>
      </div>
    );
  }
  return <p key={key}>{inline(trimmed)}</p>;
}

const alignClass: Record<Align, string> = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
};

/**
 * A real table.
 *
 * Scrolls horizontally rather than wrapping: a WCAG criterion or a long endpoint
 * path squeezed into a 380px panel becomes unreadable when it wraps mid-cell.
 */
function MarkdownTable({ rows, align }: { rows: string[][]; align: Align[] }) {
  if (rows.length === 0) return null;
  const [header, ...body] = rows;
  const alignOf = (col: number): string => alignClass[align[col] ?? 'left'];
  return (
    <div className="my-2 -mx-0.5 overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-2xs">
        <thead>
          <tr className="bg-surface-3">
            {header.map((cell, c) => (
              <th key={c} className={`px-2 py-1.5 font-semibold text-text-primary whitespace-nowrap ${alignOf(c)}`}>
                {inline(cell)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r} className={r % 2 === 1 ? 'bg-surface-2/50' : undefined}>
              {row.map((cell, c) => (
                <td key={c} className={`px-2 py-1.5 align-top border-t border-border ${alignOf(c)}`}>
                  {inline(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Inline formatting: **bold**, `code`, and _italic_. */
function inline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i} className="text-text-primary">{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={i} className="font-mono text-2xs bg-surface-3 px-1 rounded text-text-primary">{part.slice(1, -1)}</code>;
    if (part.length > 2 && part.startsWith('_') && part.endsWith('_')) return <em key={i} className="text-text-muted">{part.slice(1, -1)}</em>;
    return part;
  });
}

/** Host + last path segment — enough to identify a page in a narrow label. */
function shortenForLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const tail = parsed.pathname.split('/').filter(Boolean).pop();
    return tail ? `${parsed.host}/${tail}` : parsed.host;
  } catch {
    return url.slice(0, 40);
  }
}
