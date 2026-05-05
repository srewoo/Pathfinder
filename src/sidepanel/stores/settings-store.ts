import { create } from 'zustand';
import type { Settings, AIProvider, Theme, ExecutionPreset, PlanningMode, TestPersonalityId } from '../../storage/schemas';
import { executionPresetStorage, settingsStorage } from '../../storage/chrome-storage';
import { getDefaultModel, getDefaultEmbeddingModel } from '../../core/ai/ai-client';
import { generateId } from '../../utils/hash';

interface SettingsState extends Settings {
  executionPresets: ExecutionPreset[];
  loaded: boolean;
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
  agentMode: true,
  planningMode: 'auto' as PlanningMode,
  testPersonality: 'balanced' as TestPersonalityId,
  customPersonalityPrompt: undefined,
  executionPresets: [],
  loaded: false,

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
    set({ provider, model, embeddingModel });
    await get().save();
  },

  setApiKey: async (apiKey) => {
    set({ apiKey });
    await get().save();
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
      setAgentMode: _am,
      setPlanningMode: _pm,
      setWebhook: _sw,
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
