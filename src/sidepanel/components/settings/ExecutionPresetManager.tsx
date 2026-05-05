import React, { useMemo, useState } from 'react';
import { ShieldCheck, UserRound, Trash2, Pencil, Sparkles, Cookie } from 'lucide-react';
import { useSettingsStore } from '../../stores/settings-store';
import { Button } from '../shared/Button';
import { Badge } from '../shared/Badge';
import { sendToBackground } from '../../../messaging/messenger';

interface PresetFormState {
  id?: string;
  name: string;
  description: string;
  personaLabel: string;
  startUrl: string;
  requiresAuthenticatedSession: boolean;
  setupNotes: string;
  setupStepsText: string;
  authCheckUrl: string;
  authCheckSelector: string;
  logoutIndicatorSelector: string;
}

const EMPTY_FORM: PresetFormState = {
  name: '',
  description: '',
  personaLabel: '',
  startUrl: '',
  requiresAuthenticatedSession: true,
  setupNotes: '',
  setupStepsText: '',
  authCheckUrl: '',
  authCheckSelector: '',
  logoutIndicatorSelector: '',
};

export function ExecutionPresetManager() {
  const store = useSettingsStore();
  const [form, setForm] = useState<PresetFormState>(EMPTY_FORM);

  const sortedPresets = useMemo(
    () => [...store.executionPresets].sort((a, b) => a.name.localeCompare(b.name)),
    [store.executionPresets]
  );

  const reset = () => setForm(EMPTY_FORM);

  const handleSave = async () => {
    if (!form.name.trim()) return;

    const setupSteps = form.setupStepsText
      .split('\n')
      .map((line) => line.replace(/^[\d]+[.)]\s*/, '').replace(/^[-•]\s*/, '').trim())
      .filter(Boolean);

    await store.saveExecutionPreset({
      id: form.id,
      name: form.name,
      description: form.description,
      personaLabel: form.personaLabel,
      startUrl: form.startUrl,
      requiresAuthenticatedSession: form.requiresAuthenticatedSession,
      setupNotes: form.setupNotes,
      setupSteps,
      authCheckUrl: form.authCheckUrl || undefined,
      authCheckSelector: form.authCheckSelector || undefined,
      logoutIndicatorSelector: form.logoutIndicatorSelector || undefined,
    });

    reset();
  };

  const handleEdit = (presetId: string) => {
    const preset = store.executionPresets.find((item) => item.id === presetId);
    if (!preset) return;

    setForm({
      id: preset.id,
      name: preset.name,
      description: preset.description ?? '',
      personaLabel: preset.personaLabel ?? '',
      startUrl: preset.startUrl ?? '',
      requiresAuthenticatedSession: preset.requiresAuthenticatedSession,
      setupNotes: preset.setupNotes ?? '',
      setupStepsText: preset.setupSteps?.join('\n') ?? '',
      authCheckUrl: preset.authCheckUrl ?? '',
      authCheckSelector: preset.authCheckSelector ?? '',
      logoutIndicatorSelector: preset.logoutIndicatorSelector ?? '',
    });
  };

  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface-2 p-3">
      <div>
        <div className="flex items-center gap-2">
          <Badge variant="primary" dot>
            Execution Presets
          </Badge>
          <Badge variant="neutral">{sortedPresets.length} saved</Badge>
        </div>
        <p className="mt-2 text-2xs text-text-muted">
          Save reusable personas, auth expectations, start URLs, and setup blocks. New tests can inherit these before the main flow runs.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-text-secondary">Preset name</label>
          <input
            type="text"
            value={form.name}
            onChange={(e) => setForm((current) => ({ ...current, name: e.target.value }))}
            placeholder="Admin signed-in smoke"
            className="w-full h-8 bg-surface-3 border border-border rounded-lg px-3 text-xs text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors"
          />
        </div>
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-text-secondary">Persona</label>
          <input
            type="text"
            value={form.personaLabel}
            onChange={(e) => setForm((current) => ({ ...current, personaLabel: e.target.value }))}
            placeholder="Admin"
            className="w-full h-8 bg-surface-3 border border-border rounded-lg px-3 text-xs text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-text-secondary">Default start URL</label>
        <input
          type="url"
          value={form.startUrl}
          onChange={(e) => setForm((current) => ({ ...current, startUrl: e.target.value }))}
          placeholder="https://app.example.com/dashboard"
          className="w-full h-8 bg-surface-3 border border-border rounded-lg px-3 text-xs text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors font-mono"
        />
      </div>

      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-text-secondary">What this preset is for</label>
        <textarea
          value={form.description}
          onChange={(e) => setForm((current) => ({ ...current, description: e.target.value }))}
          rows={2}
          placeholder="Regression runs for an already-authenticated admin user."
          className="w-full bg-surface-3 border border-border rounded-lg px-3 py-2 text-xs text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors resize-none"
        />
      </div>

      <label className="flex items-start gap-2 rounded-lg border border-border bg-surface-1 p-2.5">
        <input
          type="checkbox"
          checked={form.requiresAuthenticatedSession}
          onChange={(e) =>
            setForm((current) => ({
              ...current,
              requiresAuthenticatedSession: e.target.checked,
            }))
          }
          className="mt-0.5 h-3.5 w-3.5 rounded border-border bg-surface-1 text-primary focus:ring-primary/50"
        />
        <div>
          <p className="text-xs font-medium text-text-primary">Requires authenticated session</p>
          <p className="text-2xs text-text-muted mt-0.5">
            Preflight will warn or block when the current tab still looks like a login page.
          </p>
        </div>
      </label>

      {/* Auth detection fields — shown when auth is required */}
      {form.requiresAuthenticatedSession && (
        <div className="space-y-2 p-2.5 rounded-lg border border-border bg-surface-1">
          <p className="text-2xs font-medium text-text-secondary">Auth Detection (Optional)</p>
          <div className="space-y-1.5">
            <label className="block text-2xs text-text-muted">Auth check URL (returns 200 if logged in)</label>
            <input
              type="url"
              value={form.authCheckUrl}
              onChange={(e) => setForm((current) => ({ ...current, authCheckUrl: e.target.value }))}
              placeholder="https://app.example.com/api/me"
              className="w-full h-7 bg-surface-3 border border-border rounded-md px-2 text-2xs text-text-primary outline-none focus:border-primary transition-colors font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <label className="block text-2xs text-text-muted">Logged-in indicator selector</label>
            <input
              type="text"
              value={form.authCheckSelector}
              onChange={(e) => setForm((current) => ({ ...current, authCheckSelector: e.target.value }))}
              placeholder='[data-testid="user-avatar"], .user-menu'
              className="w-full h-7 bg-surface-3 border border-border rounded-md px-2 text-2xs text-text-primary outline-none focus:border-primary transition-colors font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <label className="block text-2xs text-text-muted">Logout indicator selector (session expired)</label>
            <input
              type="text"
              value={form.logoutIndicatorSelector}
              onChange={(e) => setForm((current) => ({ ...current, logoutIndicatorSelector: e.target.value }))}
              placeholder='[data-testid="login-form"], .login-page'
              className="w-full h-7 bg-surface-3 border border-border rounded-md px-2 text-2xs text-text-primary outline-none focus:border-primary transition-colors font-mono"
            />
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-text-secondary">Setup notes</label>
        <textarea
          value={form.setupNotes}
          onChange={(e) => setForm((current) => ({ ...current, setupNotes: e.target.value }))}
          rows={2}
          placeholder="Feature flag 'project-templates' must be enabled for this environment."
          className="w-full bg-surface-3 border border-border rounded-lg px-3 py-2 text-xs text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors resize-none"
        />
      </div>

      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-text-secondary">Setup block steps</label>
        <textarea
          value={form.setupStepsText}
          onChange={(e) => setForm((current) => ({ ...current, setupStepsText: e.target.value }))}
          rows={4}
          placeholder={'1. Sign in as admin\n2. Open the Projects workspace\n3. Dismiss the release notes modal'}
          className="w-full bg-surface-3 border border-border rounded-lg px-3 py-2 text-xs text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors resize-none"
        />
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          size="xs"
          icon={<Sparkles size={11} />}
          onClick={handleSave}
          disabled={!form.name.trim()}
        >
          {form.id ? 'Update preset' : 'Save preset'}
        </Button>
        <Button variant="ghost" size="xs" onClick={reset}>
          Clear
        </Button>
      </div>

      {sortedPresets.length > 0 && (
        <div className="space-y-2 border-t border-border pt-3">
          {sortedPresets.map((preset) => (
            <div key={preset.id} className="rounded-lg border border-border bg-surface-1 p-3 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-xs font-medium text-text-primary truncate">{preset.name}</p>
                    {preset.personaLabel && (
                      <Badge variant="info">
                        <span className="inline-flex items-center gap-1">
                          <UserRound size={10} />
                          {preset.personaLabel}
                        </span>
                      </Badge>
                    )}
                    {preset.requiresAuthenticatedSession && (
                      <Badge variant="success">
                        <span className="inline-flex items-center gap-1">
                          <ShieldCheck size={10} />
                          Auth
                        </span>
                      </Badge>
                    )}
                    {preset.authCookies && preset.authCookies.length > 0 && (
                      <Badge variant="neutral">
                        <span className="inline-flex items-center gap-1">
                          <Cookie size={10} />
                          {preset.authCookies.length}
                        </span>
                      </Badge>
                    )}
                  </div>
                  {preset.description && (
                    <p className="mt-1 text-2xs text-text-muted">{preset.description}</p>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {preset.requiresAuthenticatedSession && preset.startUrl && (
                    <Button
                      variant="ghost"
                      size="xs"
                      icon={<Cookie size={10} />}
                      onClick={async () => {
                        try {
                          const resp = await sendToBackground<{ success: boolean; count?: number }>({
                            type: 'CAPTURE_AUTH_COOKIES',
                            payload: { presetId: preset.id, url: preset.startUrl! },
                          });
                          if (resp?.success) {
                            await store.load();
                          }
                        } catch { /* non-fatal */ }
                      }}
                      title="Capture auth cookies from current session"
                    />
                  )}
                  <Button
                    variant="ghost"
                    size="xs"
                    icon={<Pencil size={10} />}
                    onClick={() => handleEdit(preset.id)}
                    title="Edit preset"
                  />
                  <Button
                    variant="ghost"
                    size="xs"
                    icon={<Trash2 size={10} />}
                    onClick={() => store.deleteExecutionPreset(preset.id)}
                    title="Delete preset"
                  />
                </div>
              </div>

              {preset.startUrl && (
                <p className="text-2xs text-text-muted font-mono truncate">{preset.startUrl}</p>
              )}

              {preset.setupNotes && (
                <p className="text-2xs text-text-secondary">{preset.setupNotes}</p>
              )}

              {preset.setupSteps && preset.setupSteps.length > 0 && (
                <ol className="space-y-0.5">
                  {preset.setupSteps.map((step, index) => (
                    <li key={`${preset.id}-${index}`} className="flex gap-1.5 text-2xs text-text-muted">
                      <span className="font-mono text-primary-light">{index + 1}.</span>
                      <span>{step}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
