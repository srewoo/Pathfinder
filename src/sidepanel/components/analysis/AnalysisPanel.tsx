import { useEffect, useState } from 'react';
import { Shield, Activity, Eye, FileCheck } from 'lucide-react';
import { Button } from '../shared/Button';
import { sendToBackground } from '../../../messaging/messenger';

type AnalysisSection = 'coverage' | 'a11y' | 'contracts';

interface AnalysisReport {
  type: AnalysisSection;
  markdown: string;
  timestamp: string;
}

export function AnalysisPanel() {
  const [active, setActive] = useState<AnalysisSection>('coverage');
  const [loading, setLoading] = useState(false);
  const [reports, setReports] = useState<Map<AnalysisSection, AnalysisReport>>(new Map());

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
      if (msg.type === 'HAR_IMPACT_COMPLETE') {
        addReport('coverage', (msg.payload as { report: string }).report);
        setLoading(false);
      } else if (msg.type === 'A11Y_AUDIT_COMPLETE') {
        addReport('a11y', (msg.payload as { report: string }).report);
        setLoading(false);
      } else if (msg.type === 'CONTRACT_VALIDATION_COMPLETE') {
        addReport('contracts', (msg.payload as { report: string }).report);
        setLoading(false);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const runAnalysis = async (type: AnalysisSection) => {
    setLoading(true);
    setActive(type);
    try {
      const messageType = type === 'coverage' ? 'GET_HAR_IMPACT'
        : type === 'a11y' ? 'RUN_A11Y_AUDIT'
        : 'VALIDATE_API_CONTRACTS';
      await sendToBackground({ type: messageType } as any);
    } catch {
      setLoading(false);
    }
  };

  const currentReport = reports.get(active);

  const sections: Array<{ id: AnalysisSection; icon: React.ElementType; label: string; description: string }> = [
    { id: 'coverage', icon: Activity, label: 'API Coverage', description: 'Which API endpoints are tested vs untested' },
    { id: 'a11y', icon: Eye, label: 'Accessibility', description: 'WCAG issues found via CDP accessibility tree' },
    { id: 'contracts', icon: FileCheck, label: 'API Contracts', description: 'Validate responses against OpenAPI spec' },
  ];

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
              onClick={() => setActive(section.id)}
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

      {/* Description */}
      <p className="text-2xs text-text-muted">
        {sections.find((s) => s.id === active)?.description}
      </p>

      {/* Run button */}
      <Button
        onClick={() => runAnalysis(active)}
        disabled={loading}
        className="w-full"
      >
        {loading ? 'Running...' : `Run ${sections.find((s) => s.id === active)?.label} Analysis`}
      </Button>

      {/* Report output */}
      {currentReport ? (
        <div className="mt-4">
          <div className="flex justify-between items-center mb-2">
            <span className="text-2xs text-text-muted">Last run: {currentReport.timestamp}</span>
          </div>
          <div className="bg-surface-1 border border-border rounded p-3 text-xs overflow-y-auto max-h-[400px]">
            <pre className="whitespace-pre-wrap font-mono text-2xs leading-relaxed">{currentReport.markdown}</pre>
          </div>
        </div>
      ) : (
        <div className="text-center text-text-muted text-xs py-8">
          No report yet. Run an analysis to see results.
        </div>
      )}
    </div>
  );
}
