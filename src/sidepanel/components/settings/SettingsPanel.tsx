import { useState } from "react";
import { Trash2, Cpu, Globe, Image, Webhook, Zap, CheckCircle, XCircle, Bot, FlaskConical, Bug } from 'lucide-react';
import type { PlanningMode } from '../../../storage/schemas';
import { useSettingsStore } from '../../stores/settings-store';
import { SegmentedControl } from '../shared/SegmentedControl';
import { ProviderSelect } from './ProviderSelect';
import { ApiKeyConfig } from './ApiKeyConfig';
import { ModelSelect, TestKeyButton } from './ModelSelect';
import { TestPersonalitySelect } from './TestPersonalitySelect';
import { chatModels, embeddingModels } from '../../../core/ai/model-catalog';
import { ExecutionPresetManager } from './ExecutionPresetManager';
import { Button } from '../shared/Button';
import { Badge } from '../shared/Badge';
import { sendToBackground } from '../../../messaging/messenger';
import type { AIProvider, WebhookConfig } from '../../../storage/schemas';
import { hasPermissionFor, requestPermissionFor } from '../../../drivers/host-permissions';
import { createTestRailClient } from '../../../core/integrations/testrail-client';

export function SettingsPanel() {
  const store = useSettingsStore();

  const handleClearData = async () => {
    if (!confirm('Clear all crawled data, flows, and test results?')) return;
    const { sendToBackground } = await import('../../../messaging/messenger');
    await sendToBackground({ type: 'CLEAR_ALL_DATA' });
  };

  return (
    <div className="flex flex-col gap-4 p-3">
      <div>
        <h2 className="text-xs font-semibold text-text-primary mb-1">AI Configuration</h2>
        <p className="text-2xs text-text-muted">Configure your AI provider and API key.</p>
      </div>

      <ProviderSelect
        value={store.provider}
        onChange={(p: AIProvider) => store.setProvider(p)}
      />

      <ApiKeyConfig
        value={store.apiKey}
        onChange={(key) => store.setApiKey(key)}
        provider={store.provider}
      />

      <TestKeyButton
        status={store.keyTest}
        onTest={() => void store.testApiKey()}
        disabled={!store.apiKey.trim()}
      />

      <ModelSelect
        label="Model"
        value={store.model}
        onChange={(model) => void store.setModel(model)}
        options={chatModels(store.modelCatalog)}
        placeholder="e.g. gpt-4o"
        hint="Test the key to list the models it can actually call."
      />

      {/* ── Embedding mode toggle ── */}
      <div className="rounded-lg border border-border overflow-hidden">
        {/* Local option */}
        <button
          onClick={() => store.setUseLocalEmbeddings(true)}
          className={[
            'w-full flex items-start gap-3 p-3 text-left transition-colors',
            store.useLocalEmbeddings
              ? 'bg-primary-dim border-b border-primary/20'
              : 'bg-surface-2 hover:bg-surface-3 border-b border-border',
          ].join(' ')}
        >
          <div className={`mt-0.5 flex-shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center ${store.useLocalEmbeddings ? 'border-primary bg-primary' : 'border-border'}`}>
            {store.useLocalEmbeddings && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <Cpu size={11} className="text-primary flex-shrink-0" />
              <span className="text-xs font-medium text-text-primary">Local (Free)</span>
              <span className="text-2xs bg-success-dim text-success-text px-1.5 py-0.5 rounded-full font-medium">No API key</span>
            </div>
            <p className="text-2xs text-text-muted mt-0.5">
              all-MiniLM-L6-v2 · 384-dim · ~23 MB download once
            </p>
          </div>
        </button>

        {/* API option */}
        <button
          onClick={() => store.setUseLocalEmbeddings(false)}
          className={[
            'w-full flex items-start gap-3 p-3 text-left transition-colors',
            !store.useLocalEmbeddings
              ? 'bg-primary-dim'
              : 'bg-surface-2 hover:bg-surface-3',
          ].join(' ')}
        >
          <div className={`mt-0.5 flex-shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center ${!store.useLocalEmbeddings ? 'border-primary bg-primary' : 'border-border'}`}>
            {!store.useLocalEmbeddings && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <Globe size={11} className="text-info flex-shrink-0" />
              <span className="text-xs font-medium text-text-primary">API Embeddings</span>
            </div>
            <p className="text-2xs text-text-muted mt-0.5">
              Use provider's embedding API · requires valid key
            </p>
          </div>
        </button>
      </div>

      {/* API embedding model input — hidden when using local embeddings */}
      {!store.useLocalEmbeddings && (
        <div className="space-y-2">
          <ModelSelect
            label="Embedding Model"
            value={store.embeddingModel}
            onChange={(model) => void store.setEmbeddingModel(model)}
            options={embeddingModels(store.modelCatalog)}
            placeholder="e.g. text-embedding-3-small"
          />
          {store.provider === 'anthropic' && (
            <p className="text-2xs text-warning-text">
              Anthropic has no embedding API — switch to Local or use OpenAI/Google.
            </p>
          )}
        </div>
      )}

      {store.useLocalEmbeddings && (
        <p className="text-2xs text-text-muted bg-surface-2 rounded-lg px-3 py-2 border border-border">
          If you previously crawled using API embeddings, clear all data and re-crawl — vector dimensions differ (384 vs 1536).
        </p>
      )}

      {/* ── Image description toggle ── */}
      <div className="rounded-lg border border-border overflow-hidden">
        <button
          onClick={() => store.setDescribeImages(!store.describeImages)}
          className={[
            'w-full flex items-start gap-3 p-3 text-left transition-colors',
            store.describeImages
              ? 'bg-primary-dim'
              : 'bg-surface-2 hover:bg-surface-3',
          ].join(' ')}
        >
          <div className={`mt-0.5 flex-shrink-0 w-4 h-4 rounded border-2 flex items-center justify-center ${store.describeImages ? 'border-primary bg-primary' : 'border-border'}`}>
            {store.describeImages && <div className="w-1.5 h-1.5 bg-white rounded-sm" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <Image size={11} className="text-primary flex-shrink-0" />
              <span className="text-xs font-medium text-text-primary">Describe Images (Vision AI)</span>
              <span className="text-2xs bg-warning-dim text-warning-text px-1.5 py-0.5 rounded-full font-medium">API cost</span>
            </div>
            <p className="text-2xs text-text-muted mt-0.5">
              Use AI vision to describe screenshots and diagrams in help articles during crawl. ~$0.01-0.03 per image.
            </p>
          </div>
        </button>
      </div>

      {/* ── Debug: retain redacted response bodies (ADR 001 phase 4) ── */}
      <div className="rounded-lg border border-border overflow-hidden">
        <button
          onClick={() => store.setRetainResponseBodies(!store.retainResponseBodies)}
          className={[
            'w-full flex items-start gap-3 p-3 text-left transition-colors',
            store.retainResponseBodies ? 'bg-primary-dim' : 'bg-surface-2 hover:bg-surface-3',
          ].join(' ')}
        >
          <div className={`mt-0.5 flex-shrink-0 w-4 h-4 rounded border-2 flex items-center justify-center ${store.retainResponseBodies ? 'border-primary bg-primary' : 'border-border'}`}>
            {store.retainResponseBodies && <div className="w-1.5 h-1.5 bg-white rounded-sm" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <Bug size={11} className="text-primary flex-shrink-0" />
              <span className="text-xs font-medium text-text-primary">Retain API response bodies</span>
              <span className="text-2xs bg-warning-dim text-warning-text px-1.5 py-0.5 rounded-full font-medium">debug</span>
            </div>
            <p className="text-2xs text-text-muted mt-0.5">
              Keeps redacted response bodies for 24h so you can see why a contract check fired.
              Tokens, emails and personal fields are masked before storage; bodies are never
              exported, and switching this off deletes them. Contract checking itself needs only
              schemas, which are always stored.
            </p>
          </div>
        </button>
      </div>

      {/* ── Agent Mode toggle ── */}
      <div className="rounded-lg border border-border overflow-hidden">
        <button
          onClick={() => store.setAgentMode(!store.agentMode)}
          className={[
            'w-full flex items-start gap-3 p-3 text-left transition-colors',
            store.agentMode
              ? 'bg-primary-dim'
              : 'bg-surface-2 hover:bg-surface-3',
          ].join(' ')}
        >
          <div className={`mt-0.5 flex-shrink-0 w-4 h-4 rounded border-2 flex items-center justify-center ${store.agentMode ? 'border-primary bg-primary' : 'border-border'}`}>
            {store.agentMode && <div className="w-1.5 h-1.5 bg-white rounded-sm" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <Bot size={11} className="text-primary flex-shrink-0" />
              <span className="text-xs font-medium text-text-primary">AI-Guided Exploration</span>
              <span className="text-2xs bg-primary-dim text-primary px-1.5 py-0.5 rounded-full font-medium">Recommended</span>
            </div>
            <p className="text-2xs text-text-muted mt-0.5">
              AI ranks which elements to explore per page — higher quality graphs. ~1 extra AI call per page.
            </p>
          </div>
        </button>
      </div>

      {/* ── Planning Mode ── */}
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-text-secondary">
          <div className="flex items-center gap-1.5">
            <FlaskConical size={11} className="text-text-muted" />
            Planning Mode
          </div>
        </label>
        <SegmentedControl
          options={[
            { id: 'auto', label: 'Auto' },
            { id: 'interactive', label: 'Interactive' },
            { id: 'single-shot', label: 'Single-shot' },
          ]}
          value={store.planningMode}
          onChange={(mode) => store.setPlanningMode(mode as PlanningMode)}
          stacked={false}
          label="Planning mode"
        />
        <p className="text-2xs text-text-muted">
          {store.planningMode === 'auto'
            ? 'Interactive first, falls back to single-shot on retry. Best results.'
            : store.planningMode === 'interactive'
            ? 'Walks the app live step-by-step before generating the plan. Most accurate.'
            : 'Generates all steps from a single DOM snapshot. Fastest.'}
        </p>
      </div>

      <TestPersonalitySelect
        value={store.testPersonality ?? 'balanced'}
        customPrompt={store.customPersonalityPrompt ?? ''}
        onChange={(id) => void store.setTestPersonality(id)}
        onCustomPromptChange={(prompt) => void store.setCustomPersonalityPrompt(prompt)}
      />

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-text-secondary">Max Crawl Pages</label>
          <input
            type="number"
            value={store.maxCrawlPages}
            min={5}
            max={1500}
            onChange={(e) => store.setMaxCrawlPages(Number(e.target.value))}
            className="w-full h-8 bg-surface-3 border border-border rounded-lg px-3 text-xs text-text-primary outline-none focus:border-primary transition-colors"
          />
        </div>
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-text-secondary">Explore Depth</label>
          <input
            type="number"
            value={store.maxExplorationDepth}
            min={1}
            max={10}
            onChange={(e) => store.setMaxExplorationDepth(Number(e.target.value))}
            className="w-full h-8 bg-surface-3 border border-border rounded-lg px-3 text-xs text-text-primary outline-none focus:border-primary transition-colors"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-text-secondary">
          Test Concurrency
          <span className="ml-1.5 text-2xs text-text-muted font-normal">(parallel tabs)</span>
        </label>
        <SegmentedControl
          options={[1, 2, 3, 4].map((n) => ({
            id: String(n) as '1' | '2' | '3' | '4',
            label: n === 1 ? '1 (seq)' : `${n}×`,
          }))}
          value={String(store.testConcurrency) as '1' | '2' | '3' | '4'}
          onChange={(n) => store.setTestConcurrency(Number(n))}
          stacked={false}
          size="md"
          label="Test concurrency"
        />
        <p className="text-2xs text-text-muted">
          {store.testConcurrency === 1
            ? 'Tests run one at a time.'
            : `Up to ${store.testConcurrency} tests run simultaneously in separate tabs.`}
        </p>
      </div>

      <ExecutionPresetManager />

      <WebhookSettings />
      <TestRailSettings />

      <div className="border-t border-border pt-3">
        <Button
          variant="danger"
          fullWidth
          icon={<Trash2 size={12} />}
          onClick={handleClearData}
        >
          Clear All Data
        </Button>
        <p className="text-2xs text-text-muted mt-2 text-center">
          Removes crawled knowledge, flows, and test results
        </p>
      </div>
    </div>
  );
}

/**
 * TestRail credentials.
 *
 * ADR-002 holds: these go only to the user's own TestRail host, over a host
 * permission they grant themselves. Nothing is proxied.
 */
function TestRailSettings() {
  const store = useSettingsStore();
  const [host, setHost] = useState(store.testrail?.host ?? '');
  const [email, setEmail] = useState(store.testrail?.email ?? '');
  const [apiKey, setApiKey] = useState(store.testrail?.apiKey ?? '');
  const [runId, setRunId] = useState(String(store.testrail?.lastRunId ?? ''));
  const [status, setStatus] = useState<{ kind: 'idle' | 'ok' | 'error'; message?: string }>({
    kind: 'idle',
  });

  const configured = Boolean(store.testrail?.host && store.testrail.email && store.testrail.apiKey);

  const handleSave = async () => {
    if (!host.trim() || !email.trim() || !apiKey.trim()) {
      await store.setTestRail(undefined);
      setStatus({ kind: 'idle' });
      return;
    }
    await store.setTestRail({
      host: host.trim().replace(/\/+$/, ''),
      email: email.trim(),
      apiKey: apiKey.trim(),
      lastRunId: Number(runId) || undefined,
    });
    setStatus({ kind: 'ok', message: 'Saved.' });
  };

  /**
   * Verify the credentials against a real run.
   *
   * The error text is surfaced verbatim — TestRail distinguishes a bad key from
   * a run the account cannot see, and paraphrasing that loses the distinction
   * the user needs.
   */
  const handleTest = async () => {
    setStatus({ kind: 'idle' });
    const config = { host: host.trim(), email: email.trim(), apiKey: apiKey.trim() };
    if (!config.host || !config.email || !config.apiKey) {
      setStatus({ kind: 'error', message: 'Fill in host, email and API key first.' });
      return;
    }
    try {
      if (!(await hasPermissionFor([config.host]))) {
        const granted = await requestPermissionFor([config.host]);
        if (!granted) {
          setStatus({ kind: 'error', message: `Permission to reach ${config.host} was declined.` });
          return;
        }
      }
      const tests = await createTestRailClient(config).getTests(Number(runId) || 1);
      setStatus({ kind: 'ok', message: `Connected — run has ${tests.length} test(s).` });
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface-2 p-3">
      <div>
        <div className="flex items-center gap-2">
          <Badge variant="primary" dot>
            TestRail
          </Badge>
          {configured && <Badge variant="success">Configured</Badge>}
        </div>
        <p className="mt-2 text-2xs text-text-muted">
          Import a run&apos;s cases and push results back with failure screenshots. Credentials are
          stored locally and sent only to your own TestRail host.
        </p>
      </div>

      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-text-secondary">Host</label>
        <input
          type="url"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="https://acme.testrail.io"
          className="w-full h-8 bg-surface-3 border border-border rounded-lg px-3 text-xs text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors font-mono"
        />
      </div>

      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-text-secondary">Email</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="qa@acme.com"
          className="w-full h-8 bg-surface-3 border border-border rounded-lg px-3 text-xs text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors font-mono"
        />
      </div>

      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-text-secondary">API key</label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="••••••••"
          className="w-full h-8 bg-surface-3 border border-border rounded-lg px-3 text-xs text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors font-mono"
        />
      </div>

      <div className="space-y-1.5">
        <label className="block text-2xs text-text-muted">Default run id</label>
        <input
          type="number"
          value={runId}
          onChange={(e) => setRunId(e.target.value)}
          placeholder="42"
          className="w-full h-8 bg-surface-3 border border-border rounded-lg px-3 text-xs text-text-primary outline-none focus:border-primary transition-colors font-mono"
        />
      </div>

      <div className="flex items-center gap-2">
        <Button variant="secondary" size="xs" onClick={handleSave}>
          Save
        </Button>
        <Button variant="ghost" size="xs" onClick={handleTest}>
          Test connection
        </Button>
        {status.kind === 'ok' && (
          <span className="flex items-center gap-1 text-2xs text-success-text">
            <CheckCircle size={11} /> {status.message}
          </span>
        )}
        {status.kind === 'error' && (
          <span className="flex items-center gap-1 text-2xs text-error-text">
            <XCircle size={11} />
          </span>
        )}
      </div>
      {status.kind === 'error' && (
        <p className="text-2xs text-error-text break-words">{status.message}</p>
      )}
    </div>
  );
}

function WebhookSettings() {
  const store = useSettingsStore();
  const [url, setUrl] = useState(store.webhook?.url ?? '');
  const [headersText, setHeadersText] = useState(
    store.webhook?.headers ? Object.entries(store.webhook.headers).map(([k, v]) => `${k}: ${v}`).join('\n') : ''
  );
  const [trigger, setTrigger] = useState<WebhookConfig['trigger']>(store.webhook?.trigger ?? 'suite_complete');
  const [enabled, setEnabled] = useState(store.webhook?.enabled ?? false);
  const [testStatus, setTestStatus] = useState<'idle' | 'success' | 'error'>('idle');

  const parseHeaders = (text: string): Record<string, string> | undefined => {
    const lines = text.split('\n').filter(Boolean);
    if (lines.length === 0) return undefined;
    const headers: Record<string, string> = {};
    for (const line of lines) {
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        headers[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim();
      }
    }
    return Object.keys(headers).length > 0 ? headers : undefined;
  };

  const handleSave = async () => {
    if (!url.trim()) {
      await store.setWebhook(undefined);
      return;
    }
    await store.setWebhook({
      url: url.trim(),
      headers: parseHeaders(headersText),
      trigger,
      enabled,
    });
  };

  const handleTest = async () => {
    setTestStatus('idle');
    try {
      const resp = await sendToBackground<{ success: boolean }>({
        type: 'TEST_WEBHOOK',
        payload: { url: url.trim(), headers: parseHeaders(headersText) },
      });
      setTestStatus(resp?.success ? 'success' : 'error');
    } catch {
      setTestStatus('error');
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface-2 p-3">
      <div>
        <div className="flex items-center gap-2">
          <Badge variant="primary" dot>
            CI/CD Webhook
          </Badge>
          {store.webhook?.enabled && (
            <Badge variant="success">Active</Badge>
          )}
        </div>
        <p className="mt-2 text-2xs text-text-muted">
          Send test results to an external endpoint (CI/CD pipelines, Slack, dashboards).
        </p>
      </div>

      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-text-secondary">Webhook URL</label>
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://hooks.example.com/pathfinder"
          className="w-full h-8 bg-surface-3 border border-border rounded-lg px-3 text-xs text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors font-mono"
        />
      </div>

      <div className="space-y-1.5">
        <label className="block text-2xs text-text-muted">Headers (one per line, Key: Value)</label>
        <textarea
          value={headersText}
          onChange={(e) => setHeadersText(e.target.value)}
          rows={2}
          placeholder={'Authorization: Bearer token123\nX-Custom: value'}
          className="w-full bg-surface-3 border border-border rounded-lg px-3 py-2 text-2xs text-text-primary outline-none focus:border-primary transition-colors resize-none font-mono"
        />
      </div>

      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-text-secondary">Trigger</label>
        <SegmentedControl
          options={[
            { id: 'test_complete', label: 'Each Test' },
            { id: 'suite_complete', label: 'Suite End' },
            { id: 'both', label: 'Both' },
          ]}
          value={trigger}
          onChange={setTrigger}
          stacked={false}
          label="Webhook trigger"
        />
      </div>

      <label className="flex items-center gap-2 text-xs text-text-primary">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-3.5 w-3.5 rounded border-border bg-surface-1 text-primary focus:ring-primary/50"
        />
        Enabled
      </label>

      <div className="flex items-center gap-2">
        <Button variant="primary" size="xs" icon={<Zap size={11} />} onClick={handleSave} disabled={!url.trim()}>
          Save
        </Button>
        <Button variant="ghost" size="xs" icon={<Webhook size={11} />} onClick={handleTest} disabled={!url.trim()}>
          Test
        </Button>
        {testStatus === 'success' && <CheckCircle size={14} className="text-success-text" />}
        {testStatus === 'error' && <XCircle size={14} className="text-error-text" />}
      </div>
    </div>
  );
}
