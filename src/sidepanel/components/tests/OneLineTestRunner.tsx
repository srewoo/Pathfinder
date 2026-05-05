import React, { useEffect, useMemo, useState } from 'react';
import { Bot, Play, Sparkles, Globe, ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '../shared/Button';
import { Badge } from '../shared/Badge';
import { useTestStore } from '../../stores/test-store';
import { useSettingsStore } from '../../stores/settings-store';
import { sendToBackground } from '../../../messaging/messenger';
import type { ExpandedImportedTestCase } from '../../../core/test-gen/test-importer';
import { formatExecutionPresetContext } from '../../../core/test-gen/execution-preset';

interface PreviewResponse {
  success: boolean;
  error?: string;
  tests?: ExpandedImportedTestCase[];
}

const PLACEHOLDER = `User can sign in with valid credentials
Login shows an error for wrong password
Admin can create a new project`;

export function OneLineTestRunner() {
  const store = useTestStore();
  const settings = useSettingsStore();
  const [linesText, setLinesText] = useState('');
  const [sharedContext, setSharedContext] = useState('');
  const [executionPresetId, setExecutionPresetId] = useState('');
  const [startSource, setStartSource] = useState<'current' | 'preset' | 'custom'>('current');
  const [customStartUrl, setCustomStartUrl] = useState('');
  const [currentTabUrl, setCurrentTabUrl] = useState('');
  const [expanded, setExpanded] = useState(true);
  const [loadingAction, setLoadingAction] = useState<'preview' | 'save' | 'run' | null>(null);
  const [previewedTests, setPreviewedTests] = useState<ExpandedImportedTestCase[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const url = tabs[0]?.url ?? '';
      setCurrentTabUrl(url);
    });
  }, []);

  const lines = useMemo(
    () => linesText.split('\n').map((line) => line.trim()).filter(Boolean),
    [linesText]
  );

  const selectedPreset = useMemo(
    () => settings.executionPresets.find((preset) => preset.id === executionPresetId),
    [executionPresetId, settings.executionPresets]
  );

  const presetContext = useMemo(
    () => (selectedPreset ? formatExecutionPresetContext(selectedPreset) : ''),
    [selectedPreset]
  );

  const resolvedStartUrl =
    startSource === 'current'
      ? currentTabUrl
      : startSource === 'preset'
        ? selectedPreset?.startUrl?.trim() ?? ''
        : customStartUrl.trim();

  const buildSparseTests = () =>
    lines.map((title) => ({
      title,
      context: [presetContext, sharedContext.trim()].filter(Boolean).join('\n') || undefined,
      startUrl: resolvedStartUrl || undefined,
      executionPresetId: executionPresetId || undefined,
    }));

  const handlePreview = async () => {
    if (lines.length === 0) return;

    setLoadingAction('preview');
    setLocalError(null);

    const resp = await sendToBackground<PreviewResponse>({
      type: 'PREVIEW_TESTS',
      payload: { tests: buildSparseTests() },
    });

    setLoadingAction(null);

    if (!resp?.success || !resp.tests) {
      setPreviewedTests([]);
      setLocalError(resp?.error ?? 'Could not preview test expansion');
      return;
    }

    setPreviewedTests(resp.tests);
  };

  const handleImport = async (runAfterImport: boolean) => {
    if (lines.length === 0) return;

    const action = runAfterImport ? 'run' : 'save';
    setLoadingAction(action);
    setLocalError(null);

    await store.importTests(buildSparseTests(), { runAfterImport });

    const latestError = useTestStore.getState().error;
    setLoadingAction(null);

    if (latestError) {
      setLocalError(latestError);
      return;
    }

    setLinesText('');
    setSharedContext('');
    setExecutionPresetId('');
    setStartSource('current');
    setPreviewedTests([]);
  };

  return (
    <div className="p-3 bg-surface-2 border border-border rounded-lg space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Badge variant="primary" dot>
              One-Line Runner
            </Badge>
            <Badge variant="neutral">
              {lines.length} queued
            </Badge>
          </div>
          <h2 className="text-sm font-semibold text-text-primary mt-2">Manual checks, expanded by AI</h2>
          <p className="text-2xs text-text-muted mt-1">
            Paste one manual test per line. Pathfinder expands each line into an executable test, then saves or runs just that set.
          </p>
        </div>
        <button
          onClick={() => setExpanded((value) => !value)}
          className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
          aria-label={expanded ? 'Collapse one-line runner' : 'Expand one-line runner'}
        >
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>

      {expanded && (
        <>
          <textarea
            value={linesText}
            onChange={(e) => setLinesText(e.target.value)}
            placeholder={PLACEHOLDER}
            rows={5}
            className="w-full bg-surface-3 border border-border rounded-lg px-3 py-2 text-xs text-text-primary placeholder-text-muted outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors resize-none leading-relaxed"
          />

          <div className="rounded-lg border border-border bg-surface-1 p-2.5 space-y-2">
            <div className="flex items-center gap-2 text-2xs text-text-muted">
              <Globe size={10} />
              <span className="font-medium text-text-secondary">Start URL</span>
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => setStartSource('current')}
                className={[
                  'flex-1 rounded-md border px-2 py-1.5 text-2xs transition-colors',
                  startSource === 'current'
                    ? 'bg-primary text-white border-primary'
                    : 'bg-surface-3 text-text-muted border-border hover:border-border-light',
                ].join(' ')}
              >
                Current Page
              </button>
              <button
                onClick={() => setStartSource('preset')}
                disabled={!selectedPreset?.startUrl}
                className={[
                  'flex-1 rounded-md border px-2 py-1.5 text-2xs transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
                  startSource === 'preset'
                    ? 'bg-primary text-white border-primary'
                    : 'bg-surface-3 text-text-muted border-border hover:border-border-light',
                ].join(' ')}
              >
                Preset URL
              </button>
              <button
                onClick={() => setStartSource('custom')}
                className={[
                  'flex-1 rounded-md border px-2 py-1.5 text-2xs transition-colors',
                  startSource === 'custom'
                    ? 'bg-primary text-white border-primary'
                    : 'bg-surface-3 text-text-muted border-border hover:border-border-light',
                ].join(' ')}
              >
                Custom URL
              </button>
            </div>

            {startSource === 'current' ? (
              <p className="text-2xs text-text-muted font-mono truncate">
                {currentTabUrl || 'No active tab URL detected'}
              </p>
            ) : startSource === 'preset' ? (
              <p className="text-2xs text-text-muted font-mono truncate">
                {selectedPreset?.startUrl || 'Select a preset with a default URL'}
              </p>
            ) : (
              <input
                type="url"
                value={customStartUrl}
                onChange={(e) => setCustomStartUrl(e.target.value)}
                placeholder="https://app.example.com/login"
                className="w-full h-8 bg-surface-3 border border-border rounded-lg px-3 text-xs text-text-primary placeholder-text-muted outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors font-mono"
              />
            )}
          </div>

          {settings.executionPresets.length > 0 && (
            <div className="space-y-1">
              <label className="block text-2xs font-medium text-text-secondary">
                Execution preset
                <span className="ml-1 text-text-muted font-normal">(optional)</span>
              </label>
              <select
                value={executionPresetId}
                onChange={(e) => {
                  const nextPresetId = e.target.value;
                  setExecutionPresetId(nextPresetId);
                  if (!settings.executionPresets.find((preset) => preset.id === nextPresetId)?.startUrl && startSource === 'preset') {
                    setStartSource('current');
                  }
                }}
                className="w-full h-8 bg-surface-3 border border-border rounded-lg px-3 text-xs text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors"
              >
                <option value="">No preset</option>
                {settings.executionPresets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name}
                  </option>
                ))}
              </select>
              {selectedPreset && (
                <p className="text-2xs text-text-muted leading-relaxed">
                  {selectedPreset.personaLabel
                    ? `${selectedPreset.personaLabel} preset`
                    : 'Preset selected'}
                  {selectedPreset.requiresAuthenticatedSession ? ' • requires an authenticated session' : ''}
                </p>
              )}
            </div>
          )}

          <div className="space-y-1">
            <label className="block text-2xs font-medium text-text-secondary">
              Shared Context
              <span className="ml-1 text-text-muted font-normal">(optional)</span>
            </label>
            <textarea
              value={sharedContext}
              onChange={(e) => setSharedContext(e.target.value)}
              placeholder="Admin user is already authenticated. Project creation requires a unique name."
              rows={2}
              className="w-full bg-surface-3 border border-border rounded-lg px-3 py-2 text-xs text-text-primary placeholder-text-muted outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors resize-none"
            />
          </div>

          {(localError || store.error) && (
            <div className="p-2.5 bg-error/10 border border-error/20 rounded-lg">
              <p className="text-xs text-error">{localError || store.error}</p>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              icon={<Sparkles size={11} />}
              onClick={handlePreview}
              loading={loadingAction === 'preview'}
              disabled={lines.length === 0 || store.isImporting || store.isRunning}
            >
              Preview Expansion
            </Button>
            <Button
              variant="primary"
              icon={<Bot size={11} />}
              onClick={() => handleImport(false)}
              loading={loadingAction === 'save'}
              disabled={lines.length === 0 || store.isImporting || store.isRunning}
            >
              Save As Tests
            </Button>
            <Button
              variant="success"
              icon={<Play size={11} />}
              onClick={() => handleImport(true)}
              loading={loadingAction === 'run'}
              disabled={lines.length === 0 || store.isImporting || store.isRunning}
            >
              Expand And Run
            </Button>
          </div>

          {previewedTests.length > 0 && (
            <div className="space-y-2 border-t border-border pt-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-xs font-medium text-text-primary">Expansion Preview</h3>
                  <p className="text-2xs text-text-muted mt-0.5">
                    Review the enriched tests before saving or running them.
                  </p>
                </div>
                <Badge variant="info">{previewedTests.length} tests</Badge>
              </div>

              <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                {previewedTests.map((test, index) => (
                  <div key={`${test.title}-${index}`} className="rounded-lg border border-border bg-surface-1 p-3 space-y-2">
                    <div className="flex items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-text-primary">{test.title}</p>
                        <p className="text-2xs text-text-muted mt-1">{test.description}</p>
                      </div>
                      <Badge variant={test.type}>{test.type}</Badge>
                    </div>

                    {test.startUrl && (
                      <p className="text-2xs text-text-muted font-mono truncate">{test.startUrl}</p>
                    )}

                    <ol className="space-y-1">
                      {test.steps.map((step, stepIndex) => (
                        <li key={`${test.title}-${stepIndex}`} className="flex gap-2 text-2xs text-text-secondary">
                          <span className="text-primary-light font-mono">{stepIndex + 1}.</span>
                          <span>{step}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
