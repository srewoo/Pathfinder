import React, { useState, useEffect } from 'react';
import { AlertTriangle, Camera, Code2, ChevronDown, ChevronRight, Wrench } from 'lucide-react';
import type { TestResult } from '../../../storage/schemas';
import { StatusIndicator } from '../shared/StatusIndicator';

/**
 * Convert a base64 data URL to a blob URL that works under MV3 CSP.
 * Extension pages block data: URIs in img src by default.
 */
function useDataUrlAsBlobUrl(dataUrl: string | undefined): string | undefined {
  const [blobUrl, setBlobUrl] = useState<string>();

  useEffect(() => {
    if (!dataUrl) { setBlobUrl(undefined); return; }

    // If it's already a blob URL, use as-is
    if (dataUrl.startsWith('blob:')) { setBlobUrl(dataUrl); return; }

    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) { setBlobUrl(dataUrl); return; }

    const mimeType = match[1];
    const byteChars = atob(match[2]);
    const bytes = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) {
      bytes[i] = byteChars.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);
    setBlobUrl(url);

    return () => URL.revokeObjectURL(url);
  }, [dataUrl]);

  return blobUrl;
}

interface FailureDetailProps {
  result: TestResult;
}

export function FailureDetail({ result }: FailureDetailProps) {
  const [showScreenshot, setShowScreenshot] = useState(false);
  const [showDOM, setShowDOM] = useState(false);
  const screenshotUrl = useDataUrlAsBlobUrl(result.screenshot);

  const failedSteps = result.steps.filter((s) => s.status === 'failed' || s.status === 'skipped');

  return (
    <div className="space-y-3 mt-2 pb-2">
      {result.errorMessage && (
        <div className="flex items-start gap-2 p-2.5 bg-error/10 border border-error/20 rounded-lg">
          <AlertTriangle size={12} className="text-error flex-shrink-0 mt-0.5" />
          <p className="text-xs text-error font-mono leading-relaxed">{result.errorMessage}</p>
        </div>
      )}

      {failedSteps.length > 0 && (
        <div>
          <p className="text-2xs font-medium text-text-muted uppercase tracking-wide mb-1.5">
            Failed Steps
          </p>
          <div className="space-y-1">
            {failedSteps.map((step, i) => (
              <div
                key={i}
                className="p-2 bg-surface-3 border border-border rounded-lg text-xs"
              >
                <div className="flex items-center gap-2">
                  <StatusIndicator status={step.status} size={12} />
                  <span className="font-mono text-text-secondary">{step.step.action}</span>
                  <span className="text-text-primary">{step.step.description}</span>
                </div>
                {step.step.selector && (
                  <p className="text-2xs font-mono text-text-muted mt-1 pl-5 truncate">
                    {step.step.selector}
                  </p>
                )}
                {step.error && (
                  <p className="text-2xs text-error mt-1 pl-5">{step.error}</p>
                )}
                {step.healingAttempt && (
                  <div className="mt-1 pl-5 flex items-center gap-1 text-2xs text-warning">
                    <Wrench size={10} />
                    <span>
                      Healing via {step.healingAttempt.method}:{' '}
                      {step.healingAttempt.success ? 'success' : 'failed'}
                    </span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {result.screenshot && (
        <div>
          <button
            onClick={() => setShowScreenshot(!showScreenshot)}
            className="flex items-center gap-1.5 text-2xs font-medium text-text-secondary hover:text-text-primary transition-colors"
          >
            {showScreenshot ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            <Camera size={11} />
            Screenshot at failure
          </button>
          {showScreenshot && (
            <div className="mt-2 rounded-lg overflow-hidden border border-border">
              <img src={screenshotUrl ?? result.screenshot} alt="Screenshot at failure" className="w-full" />
            </div>
          )}
        </div>
      )}

      {result.domSnapshot && (
        <div>
          <button
            onClick={() => setShowDOM(!showDOM)}
            className="flex items-center gap-1.5 text-2xs font-medium text-text-secondary hover:text-text-primary transition-colors"
          >
            {showDOM ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            <Code2 size={11} />
            DOM Snapshot
          </button>
          {showDOM && (
            <pre className="mt-2 p-2.5 bg-surface-3 border border-border rounded-lg text-2xs text-text-secondary font-mono overflow-x-auto max-h-48 overflow-y-auto">
              {result.domSnapshot}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
