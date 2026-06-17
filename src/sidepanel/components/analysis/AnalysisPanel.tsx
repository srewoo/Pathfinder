import React, { useEffect, useRef, useState } from 'react';
import { Shield, Activity, Eye, FileCheck, AlertTriangle } from 'lucide-react';
import { Button } from '../shared/Button';
import { sendToBackground } from '../../../messaging/messenger';
import { useTestStore } from '../../stores/test-store';

type AnalysisSection = 'coverage' | 'a11y' | 'contracts';

interface AnalysisReport {
  type: AnalysisSection;
  markdown: string;
  timestamp: string;
}

/** No report after this long → surface a failure instead of spinning forever. */
const ANALYSIS_TIMEOUT_MS = 90_000;

export function AnalysisPanel() {
  const [active, setActive] = useState<AnalysisSection>('coverage');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reports, setReports] = useState<Map<AnalysisSection, AnalysisReport>>(new Map());
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resultCount = useTestStore((s) => s.results.length);

  const clearTimer = () => {
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
  };

  const addReport = (type: AnalysisSection, markdown: string) => {
    setReports((prev) => {
      const next = new Map(prev);
      next.set(type, { type, markdown, timestamp: new Date().toLocaleTimeString() });
      return next;
    });
  };

  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage) return;
    const listener = (msg: Record<string, unknown>) => {
      const done = (type: AnalysisSection) => {
        addReport(type, (msg.payload as { report: string }).report);
        setLoading(false);
        setError(null);
        clearTimer();
      };
      if (msg.type === 'HAR_IMPACT_COMPLETE') done('coverage');
      else if (msg.type === 'A11Y_AUDIT_COMPLETE') done('a11y');
      else if (msg.type === 'CONTRACT_VALIDATION_COMPLETE') done('contracts');
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => { chrome.runtime.onMessage.removeListener(listener); clearTimer(); };
  }, []);

  const runAnalysis = async (type: AnalysisSection) => {
    setLoading(true);
    setError(null);
    setActive(type);
    clearTimer();
    timeoutRef.current = setTimeout(() => {
      setLoading(false);
      setError('Analysis timed out. Make sure you have run tests (for coverage/contracts) and that the app tab is open.');
    }, ANALYSIS_TIMEOUT_MS);
    try {
      const messageType = type === 'coverage' ? 'GET_HAR_IMPACT'
        : type === 'a11y' ? 'RUN_A11Y_AUDIT'
        : 'VALIDATE_API_CONTRACTS';
      await sendToBackground({ type: messageType } as never);
    } catch (err) {
      clearTimer();
      setLoading(false);
      setError(err instanceof Error ? err.message : 'Failed to start analysis.');
    }
  };

  const currentReport = reports.get(active);

  const sections: Array<{ id: AnalysisSection; icon: React.ElementType; label: string; description: string; needsRun: boolean }> = [
    { id: 'coverage', icon: Activity, label: 'API Coverage', description: 'Which API endpoints are tested vs untested', needsRun: true },
    { id: 'a11y', icon: Eye, label: 'Accessibility', description: 'WCAG issues found via the CDP accessibility tree', needsRun: false },
    { id: 'contracts', icon: FileCheck, label: 'API Contracts', description: 'Validate responses against an OpenAPI spec', needsRun: true },
  ];

  const activeSection = sections.find((s) => s.id === active)!;
  // Coverage & contracts read network traffic captured while tests RUN.
  const missingPrereq = activeSection.needsRun && resultCount === 0;

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center gap-2 mb-2">
        <Shield size={16} className="text-primary" />
        <h2 className="text-sm font-semibold">Analysis</h2>
      </div>

      {/* Section tabs */}
      <div className="flex gap-1">
        {sections.map((section) => {
          const Icon = section.icon;
          const isActive = active === section.id;
          return (
            <button
              key={section.id}
              onClick={() => { setActive(section.id); setError(null); }}
              className={[
                'flex-1 flex flex-col items-center gap-1 px-2 py-2 rounded text-2xs',
                isActive ? 'bg-primary/10 text-primary' : 'text-text-muted hover:bg-surface-2',
              ].join(' ')}
            >
              <Icon size={14} />
              <span>{section.label}</span>
            </button>
          );
        })}
      </div>

      <p className="text-2xs text-text-muted">{activeSection.description}</p>

      {/* Precondition hint — coverage/contracts need executed-test traffic */}
      {missingPrereq && (
        <div className="flex items-start gap-2 p-2.5 bg-warning/10 border border-warning/30 rounded-lg">
          <AlertTriangle size={13} className="text-warning flex-shrink-0 mt-0.5" />
          <p className="text-2xs text-warning leading-relaxed">
            This analysis uses network traffic captured while tests run. Run some tests on the Tests tab first, then come back.
          </p>
        </div>
      )}

      <Button onClick={() => runAnalysis(active)} disabled={loading} className="w-full">
        {loading ? 'Running…' : `Run ${activeSection.label} Analysis`}
      </Button>

      {/* Error state — previously this stage failed silently */}
      {error && (
        <div className="flex items-start gap-2 p-2.5 bg-error/10 border border-error/30 rounded-lg">
          <AlertTriangle size={13} className="text-error flex-shrink-0 mt-0.5" />
          <p className="text-2xs text-error leading-relaxed">{error}</p>
        </div>
      )}

      {/* Report output */}
      {currentReport ? (
        <div className="mt-2">
          <div className="flex justify-between items-center mb-2">
            <span className="text-2xs text-text-muted">Last run: {currentReport.timestamp}</span>
          </div>
          <div className="bg-surface-1 border border-border rounded p-3 overflow-y-auto max-h-[420px]">
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
 * Minimal markdown renderer — enough to make analysis reports readable (headings,
 * bold, bullets, code) without pulling in a full markdown dependency.
 */
function MarkdownLite({ source }: { source: string }) {
  const lines = source.split('\n');
  return (
    <div className="space-y-1 text-xs leading-relaxed text-text-secondary">
      {lines.map((line, i) => {
        const trimmed = line.trim();
        if (!trimmed) return <div key={i} className="h-1.5" />;
        if (trimmed.startsWith('### ')) return <h4 key={i} className="text-2xs font-semibold text-text-primary uppercase tracking-wide mt-2">{inline(trimmed.slice(4))}</h4>;
        if (trimmed.startsWith('## ')) return <h3 key={i} className="text-xs font-bold text-text-primary mt-2">{inline(trimmed.slice(3))}</h3>;
        if (trimmed.startsWith('# ')) return <h2 key={i} className="text-sm font-bold text-text-primary mt-1">{inline(trimmed.slice(2))}</h2>;
        if (/^[-*]\s/.test(trimmed)) return <div key={i} className="flex gap-1.5 pl-1"><span className="text-primary-light">•</span><span>{inline(trimmed.slice(2))}</span></div>;
        return <p key={i}>{inline(trimmed)}</p>;
      })}
    </div>
  );
}

/** Inline formatting: **bold** and `code`. */
function inline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i} className="text-text-primary">{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={i} className="font-mono text-2xs bg-surface-3 px-1 rounded text-text-primary">{part.slice(1, -1)}</code>;
    return part;
  });
}
