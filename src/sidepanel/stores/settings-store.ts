import { create } from 'zustand';
import type { Settings, AIProvider, Theme, ExecutionPreset, PlanningMode, TestPersonalityId } from '../../storage/schemas';
import { executionPresetStorage, settingsStorage } from '../../storage/chrome-storage';
import { clearRetainedBodies } from '../../storage/response-body-store';
import { getDefaultModel, getDefaultEmbeddingModel } from '../../core/ai/ai-client';
import { generateId } from '../../utils/hash';
import { sendToBackground } from '../../messaging/messenger';
import type { ModelOption } from '../../core/ai/model-catalog';
import { hasPermissionFor, requestPermissionFor } from '../../drivers/host-permissions';

/**
 * Host the catalogue is fetched from, per provider.
 *
 * Narrow on purpose: testing an OpenAI key must not ask for access to
 * Anthropic's API. `hasPermissionFor` derives the origin pattern from the URL.
 */
const PROVIDER_HOSTS: Record<AIProvider, string> = {
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  google: 'https://generativelanguage.googleapis.com',
};

export interface KeyTestStatus {
  state: 'idle' | 'testing' | 'ok' | 'error';
  message?: string;
}

interface SettingsState extends Settings {
  executionPresets: ExecutionPreset[];
  loaded: boolean;
  /**
   * Models the saved key is entitled to call. Empty until the key is tested —
   * an untested key has no verified catalogue, and guessing one is what made
   * the old free-text field fail mid-crawl.
   */
  modelCatalog: ModelOption[];
  /** Provider the catalogue belongs to, so a provider switch invalidates it. */
  modelCatalogProvider?: AIProvider;
  keyTest: KeyTestStatus;
  /** Verify the key by listing the models it can call. Never throws. */
  testApiKey: () => Promise<void>;
  load: () => Promise<void>;
  setProvider: (provider: AIProvider) => Promise<void>;
  setApiKey: (key: string) => Promise<void>;
  setModel: (model: string) => Promise<void>;
  setEmbeddingModel: (model: string) => Promise<void>;
  setMaxExplorationDepth: (depth: number) => Promise<void>;
  setMaxCrawlPages: (pages: number) => Promise<void>;
  setTheme: (theme: Theme) => Promise<void>;
  setUseLocalEmbeddings: (value: boolean) => Promise<void>;
  setTestConcurrency: (concurrency: number) => Promise<void>;
  setDescribeImages: (value: boolean) => Promise<void>;
  /** Debug: retain redacted response bodies for 24h (ADR 001 phase 4). */
  setRetainResponseBodies: (value: boolean) => Promise<void>;
  setAgentMode: (value: boolean) => Promise<void>;
  setPlanningMode: (mode: PlanningMode) => Promise<void>;
  saveExecutionPreset: (preset: {
    id?: string;
    name: string;
    description?: string;
    personaLabel?: string;
    startUrl?: string;
    requiresAuthenticatedSession: boolean;
    setupSteps?: string[];
    setupNotes?: string;
    authCheckUrl?: string;
    authCheckSelector?: string;
    logoutIndicatorSelector?: string;
  }) => Promise<void>;
  setWebhook: (webhook: import('../../storage/schemas').WebhookConfig | undefined) => Promise<void>;
  setTestRail: (testrail: Settings['testrail']) => Promise<void>;
  setTestPersonality: (personality: TestPersonalityId) => Promise<void>;
  setCustomPersonalityPrompt: (prompt: string) => Promise<void>;
  deleteExecutionPreset: (presetId: string) => Promise<void>;
  save: () => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  provider: 'openai',
  apiKey: '',
  model: 'gpt-5',
  embeddingModel: 'text-embedding-3-small',
  maxExplorationDepth: 5,
  maxCrawlPages: 200,
  theme: 'light',
  useLocalEmbeddings: false,
  testConcurrency: 1,
  describeImages: false,
  // Off by default: retention stores payloads, and that must be a decision.
  retainResponseBodies: false,
  agentMode: true,
  planningMode: 'auto' as PlanningMode,
  testPersonality: 'balanced' as TestPersonalityId,
  customPersonalityPrompt: undefined,
  executionPresets: [],
  loaded: false,
  modelCatalog: [],
  modelCatalogProvider: undefined,
  keyTest: { state: 'idle' },

  load: async () => {
    const [settings, executionPresets] = await Promise.all([
      settingsStorage.get(),
      executionPresetStorage.getAll(),
    ]);
    set({ ...settings, executionPresets, loaded: true });
  },

  setProvider: async (provider) => {
    const model = getDefaultModel(provider);
    const embeddingModel = getDefaultEmbeddingModel(provider);
    // The catalogue belongs to the old provider — keeping it would offer models
    // the new provider cannot run.
    set({
      provider,
      model,
      embeddingModel,
      modelCatalog: [],
      modelCatalogProvider: undefined,
      keyTest: { state: 'idle' },
    });
    await get().save();
  },

  setApiKey: async (apiKey) => {
    // A new key may have entirely different entitlements, so the catalogue it
    // was verified against no longer applies.
    set({ apiKey, modelCatalog: [], modelCatalogProvider: undefined, keyTest: { state: 'idle' } });
    await get().save();
  },

  testApiKey: async () => {
    const { provider, apiKey } = get();
    if (!apiKey.trim()) {
      set({ keyTest: { state: 'error', message: 'Enter an API key first.' } });
      return;
    }

    set({ keyTest: { state: 'testing' } });
    const host = PROVIDER_HOSTS[provider];
    try {
      if (!(await hasPermissionFor([host])) && !(await requestPermissionFor([host]))) {
        set({
          keyTest: {
            state: 'error',
            message: `Permission to reach ${host} was declined — grant it to test the key.`,
          },
        });
        return;
      }

      const response = await sendToBackground<{
        success: boolean;
        models?: ModelOption[];
        error?: string;
      }>({ type: 'LIST_MODELS', payload: { provider, apiKey } });

      if (!response?.success || !response.models) {
        set({ keyTest: { state: 'error', message: response?.error ?? 'The model list could not be read.' } });
        return;
      }

      const models = response.models;
      const chat = models.filter((m) => m.kind === 'chat');
      set({
        modelCatalog: models,
        modelCatalogProvider: provider,
        keyTest: {
          state: 'ok',
          message: `Key verified — ${chat.length} chat model${chat.length === 1 ? '' : 's'} available.`,
        },
      });

      // A saved model the key cannot actually call is the failure this feature
      // exists to prevent, so correct it rather than leaving it to fail later.
      const { model } = get();
      if (chat.length > 0 && !chat.some((m) => m.id === model)) {
        await get().setModel(chat[0].id);
      }
    } catch (err) {
      set({ keyTest: { state: 'error', message: err instanceof Error ? err.message : String(err) } });
    }
  },

  setModel: async (model) => {
    set({ model });
    await get().save();
  },

  setEmbeddingModel: async (embeddingModel) => {
    set({ embeddingModel });
    await get().save();
  },

  setMaxExplorationDepth: async (maxExplorationDepth) => {
    set({ maxExplorationDepth });
    await get().save();
  },

  setMaxCrawlPages: async (maxCrawlPages) => {
    set({ maxCrawlPages });
    await get().save();
  },

  setTheme: async (theme) => {
    set({ theme });
    await get().save();
  },

  setUseLocalEmbeddings: async (useLocalEmbeddings) => {
    set({ useLocalEmbeddings });
    await get().save();
  },

  setTestConcurrency: async (testConcurrency) => {
    set({ testConcurrency: Math.max(1, Math.min(4, testConcurrency)) });
    await get().save();
  },

  setDescribeImages: async (describeImages) => {
    set({ describeImages });
    await get().save();
  },

  setRetainResponseBodies: async (retainResponseBodies) => {
    set({ retainResponseBodies });
    await get().save();
    // Switching it OFF drops what was already stored. Leaving payloads behind after
    // the user withdrew consent would be the wrong default by a wide margin.
    if (!retainResponseBodies) await clearRetainedBodies();
  },

  setAgentMode: async (agentMode) => {
    set({ agentMode });
    await get().save();
  },

  setPlanningMode: async (planningMode) => {
    set({ planningMode });
    await get().save();
  },

  saveExecutionPreset: async (preset) => {
    const now = new Date().toISOString();
    const existing = preset.id ? get().executionPresets.find((e) => e.id === preset.id) : undefined;
    const normalized: ExecutionPreset = {
      id: preset.id ?? generateId(),
      name: preset.name.trim(),
      description: preset.description?.trim() || undefined,
      personaLabel: preset.personaLabel?.trim() || undefined,
      startUrl: preset.startUrl?.trim() || undefined,
      requiresAuthenticatedSession: preset.requiresAuthenticatedSession,
      setupSteps: preset.setupSteps?.filter(Boolean),
      setupNotes: preset.setupNotes?.trim() || undefined,
      authCheckUrl: preset.authCheckUrl?.trim() || undefined,
      authCheckSelector: preset.authCheckSelector?.trim() || undefined,
      logoutIndicatorSelector: preset.logoutIndicatorSelector?.trim() || undefined,
      // Preserve existing cookies when editing (cookies are captured separately)
      authCookies: existing?.authCookies,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const executionPresets = await executionPresetStorage.upsert(normalized);
    set({ executionPresets });
  },

  deleteExecutionPreset: async (presetId) => {
    const executionPresets = await executionPresetStorage.delete(presetId);
    set({ executionPresets });
  },

  setWebhook: async (webhook) => {
    set({ webhook });
    await get().save();
  },

  setTestRail: async (testrail) => {
    set({ testrail });
    await get().save();
  },

  setTestPersonality: async (testPersonality) => {
    set({ testPersonality });
    await get().save();
  },

  setCustomPersonalityPrompt: async (customPersonalityPrompt) => {
    set({ customPersonalityPrompt, testPersonality: 'custom' as TestPersonalityId });
    await get().save();
  },

  save: async () => {
    const {
      executionPresets: _executionPresets,
      loaded: _loaded,
      // Session-only: the catalogue is re-verified against the live key rather
      // than persisted, so a revoked key can never look valid on reload.
      modelCatalog: _mc,
      modelCatalogProvider: _mcp,
      keyTest: _kt,
      testApiKey: _tak,
      load: _load,
      setProvider: _sp,
      setApiKey: _sk,
      setModel: _sm,
      setEmbeddingModel: _se,
      setMaxExplorationDepth: _sd,
      setMaxCrawlPages: _sc,
      setTheme: _st,
      setUseLocalEmbeddings: _sl,
      setTestConcurrency: _tc,
      setDescribeImages: _di,
      setRetainResponseBodies: _rrb,
      setAgentMode: _am,
      setPlanningMode: _pm,
      setWebhook: _sw,
      setTestRail: _str,
      setTestPersonality: _tp,
      setCustomPersonalityPrompt: _cpp,
      saveExecutionPreset: _sep,
      deleteExecutionPreset: _dep,
      save: _save,
      ...settings
    } = get();
    await settingsStorage.save(settings);
  },
}));
