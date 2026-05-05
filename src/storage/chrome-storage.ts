import type { Settings, AIProvider, ExecutionPreset } from './schemas';

const STORAGE_KEYS = {
  settings: 'pathfinder_settings',
  executionPresets: 'pathfinder_execution_presets',
  crawlUrl: 'pathfinder_crawl_url',
  lastExploreUrl: 'pathfinder_last_explore_url',
} as const;

const DEFAULT_SETTINGS: Settings = {
  provider: 'openai',
  apiKey: '',
  model: 'gpt-5',
  embeddingModel: 'text-embedding-3-small',
  maxExplorationDepth: 5,
  maxCrawlPages: 100,
  theme: 'light',
  useLocalEmbeddings: false,
  testConcurrency: 1,
  describeImages: false,
  agentMode: true,
  planningMode: 'auto',
};

function chromeGet<T>(key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result[key] as T | undefined);
      }
    });
  });
}

function chromeSet(key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: value }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

export const settingsStorage = {
  async get(): Promise<Settings> {
    const stored = await chromeGet<Partial<Settings>>(STORAGE_KEYS.settings);
    return { ...DEFAULT_SETTINGS, ...stored };
  },

  async save(settings: Settings): Promise<void> {
    await chromeSet(STORAGE_KEYS.settings, settings);
  },

  async patch(patch: Partial<Settings>): Promise<Settings> {
    const current = await settingsStorage.get();
    const updated = { ...current, ...patch };
    await settingsStorage.save(updated);
    return updated;
  },

  async getProvider(): Promise<AIProvider> {
    const settings = await settingsStorage.get();
    return settings.provider;
  },

  async getApiKey(): Promise<string> {
    const settings = await settingsStorage.get();
    return settings.apiKey;
  },

  async getModel(): Promise<string> {
    const settings = await settingsStorage.get();
    return settings.model;
  },

  async getEmbeddingModel(): Promise<string> {
    const settings = await settingsStorage.get();
    return settings.embeddingModel;
  },
};

export const executionPresetStorage = {
  async getAll(): Promise<ExecutionPreset[]> {
    const stored = await chromeGet<ExecutionPreset[]>(STORAGE_KEYS.executionPresets);
    return Array.isArray(stored) ? stored : [];
  },

  async saveAll(presets: ExecutionPreset[]): Promise<void> {
    await chromeSet(STORAGE_KEYS.executionPresets, presets);
  },

  async getById(id: string): Promise<ExecutionPreset | undefined> {
    const presets = await executionPresetStorage.getAll();
    return presets.find((preset) => preset.id === id);
  },

  async upsert(preset: ExecutionPreset): Promise<ExecutionPreset[]> {
    const presets = await executionPresetStorage.getAll();
    const next = presets.some((existing) => existing.id === preset.id)
      ? presets.map((existing) => (existing.id === preset.id ? preset : existing))
      : [...presets, preset];
    await executionPresetStorage.saveAll(next);
    return next;
  },

  async delete(id: string): Promise<ExecutionPreset[]> {
    const presets = await executionPresetStorage.getAll();
    const next = presets.filter((preset) => preset.id !== id);
    await executionPresetStorage.saveAll(next);
    return next;
  },
};

export const crawlStorage = {
  async getCrawlUrl(): Promise<string | undefined> {
    return chromeGet<string>(STORAGE_KEYS.crawlUrl);
  },

  async setCrawlUrl(url: string): Promise<void> {
    await chromeSet(STORAGE_KEYS.crawlUrl, url);
  },
};
