import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ModelOption } from '../../../src/core/ai/model-catalog';

vi.mock('../../../src/storage/chrome-storage', () => ({
  settingsStorage: { get: vi.fn(), save: vi.fn().mockResolvedValue(undefined) },
  executionPresetStorage: { getAll: vi.fn().mockResolvedValue([]) },
}));
vi.mock('../../../src/storage/response-body-store', () => ({
  clearRetainedBodies: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/messaging/messenger', () => ({ sendToBackground: vi.fn() }));
vi.mock('../../../src/drivers/host-permissions', () => ({
  hasPermissionFor: vi.fn().mockResolvedValue(true),
  requestPermissionFor: vi.fn().mockResolvedValue(true),
}));

const { useSettingsStore } = await import('../../../src/sidepanel/stores/settings-store');
const { sendToBackground } = await import('../../../src/messaging/messenger');
const { hasPermissionFor, requestPermissionFor } = await import(
  '../../../src/drivers/host-permissions'
);
const { settingsStorage } = await import('../../../src/storage/chrome-storage');

const chat = (id: string): ModelOption => ({ id, label: id, kind: 'chat' });

function catalogueOf(models: ModelOption[]) {
  vi.mocked(sendToBackground).mockResolvedValue({ success: true, models } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hasPermissionFor).mockResolvedValue(true);
  vi.mocked(requestPermissionFor).mockResolvedValue(true);
  useSettingsStore.setState({
    provider: 'openai',
    apiKey: 'sk-test',
    model: 'gpt-5',
    embeddingModel: 'text-embedding-3-small',
    modelCatalog: [],
    modelCatalogProvider: undefined,
    keyTest: { state: 'idle' },
  } as never);
});

describe('testApiKey', () => {
  it('given_a_valid_key_then_the_catalogue_is_stored_and_the_status_is_ok', async () => {
    catalogueOf([chat('gpt-5'), chat('gpt-4o')]);
    await useSettingsStore.getState().testApiKey();

    const state = useSettingsStore.getState();
    expect(state.modelCatalog.map((m) => m.id)).toEqual(['gpt-5', 'gpt-4o']);
    expect(state.modelCatalogProvider).toBe('openai');
    expect(state.keyTest.state).toBe('ok');
    expect(state.keyTest.message).toMatch(/2 chat models/);
  });

  it('given_one_chat_model_then_the_summary_is_singular', async () => {
    catalogueOf([chat('gpt-5')]);
    await useSettingsStore.getState().testApiKey();
    expect(useSettingsStore.getState().keyTest.message).toMatch(/1 chat model available/);
  });

  it('given_no_key_then_it_reports_an_error_without_calling_the_provider', async () => {
    useSettingsStore.setState({ apiKey: '  ' } as never);
    await useSettingsStore.getState().testApiKey();

    expect(sendToBackground).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().keyTest).toEqual({
      state: 'error',
      message: 'Enter an API key first.',
    });
  });

  it('given_the_provider_rejects_the_key_then_its_message_is_surfaced_verbatim', async () => {
    vi.mocked(sendToBackground).mockResolvedValue({
      success: false,
      error: 'OpenAI rejected this API key (401).',
    } as never);
    await useSettingsStore.getState().testApiKey();

    const state = useSettingsStore.getState();
    expect(state.keyTest).toEqual({ state: 'error', message: 'OpenAI rejected this API key (401).' });
    expect(state.modelCatalog).toEqual([]);
  });

  it('given_the_background_call_throws_then_it_is_reported_not_rethrown', async () => {
    vi.mocked(sendToBackground).mockRejectedValue(new Error('port closed'));
    await expect(useSettingsStore.getState().testApiKey()).resolves.toBeUndefined();
    expect(useSettingsStore.getState().keyTest).toEqual({ state: 'error', message: 'port closed' });
  });

  // Only the chosen provider's host is requested — testing an OpenAI key must
  // not ask for access to Anthropic's API.
  it('given_a_provider_then_only_that_provider_host_permission_is_requested', async () => {
    vi.mocked(hasPermissionFor).mockResolvedValue(false);
    catalogueOf([chat('claude-sonnet-4-6')]);
    useSettingsStore.setState({ provider: 'anthropic' } as never);

    await useSettingsStore.getState().testApiKey();
    expect(requestPermissionFor).toHaveBeenCalledWith(['https://api.anthropic.com']);
  });

  it('given_the_permission_is_declined_then_no_provider_call_is_made', async () => {
    vi.mocked(hasPermissionFor).mockResolvedValue(false);
    vi.mocked(requestPermissionFor).mockResolvedValue(false);

    await useSettingsStore.getState().testApiKey();
    expect(sendToBackground).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().keyTest.message).toMatch(/declined/i);
  });

  // The whole point of the catalogue: a saved model the key cannot call is the
  // failure this prevents, so it must not survive a successful test.
  it('given_the_saved_model_is_not_in_the_catalogue_then_it_switches_to_the_first_available', async () => {
    useSettingsStore.setState({ model: 'gpt-4-turbo-retired' } as never);
    catalogueOf([chat('gpt-5.1'), chat('gpt-4o')]);

    await useSettingsStore.getState().testApiKey();
    expect(useSettingsStore.getState().model).toBe('gpt-5.1');
  });

  it('given_the_saved_model_is_in_the_catalogue_then_it_is_left_alone', async () => {
    useSettingsStore.setState({ model: 'gpt-4o' } as never);
    catalogueOf([chat('gpt-5.1'), chat('gpt-4o')]);

    await useSettingsStore.getState().testApiKey();
    expect(useSettingsStore.getState().model).toBe('gpt-4o');
  });

  it('given_an_embedding_only_catalogue_then_the_chat_model_is_not_replaced_with_one', async () => {
    useSettingsStore.setState({ model: 'gpt-5' } as never);
    catalogueOf([{ id: 'text-embedding-3-small', label: 'e', kind: 'embedding' }]);

    await useSettingsStore.getState().testApiKey();
    expect(useSettingsStore.getState().model).toBe('gpt-5');
  });
});

describe('catalogue invalidation', () => {
  async function seedCatalogue() {
    catalogueOf([chat('gpt-5.1')]);
    await useSettingsStore.getState().testApiKey();
    expect(useSettingsStore.getState().modelCatalog).toHaveLength(1);
  }

  // A different key may have entirely different entitlements.
  it('given_the_key_changes_then_the_catalogue_and_status_are_cleared', async () => {
    await seedCatalogue();
    await useSettingsStore.getState().setApiKey('sk-other');

    const state = useSettingsStore.getState();
    expect(state.modelCatalog).toEqual([]);
    expect(state.modelCatalogProvider).toBeUndefined();
    expect(state.keyTest).toEqual({ state: 'idle' });
  });

  it('given_the_provider_changes_then_the_catalogue_is_cleared', async () => {
    await seedCatalogue();
    await useSettingsStore.getState().setProvider('google');

    const state = useSettingsStore.getState();
    expect(state.modelCatalog).toEqual([]);
    expect(state.keyTest).toEqual({ state: 'idle' });
  });
});

describe('persistence', () => {
  // The catalogue is session state: persisting it would let a revoked key keep
  // looking valid after a reload.
  it('given_a_save_then_the_catalogue_and_key_status_are_not_written_to_storage', async () => {
    catalogueOf([chat('gpt-5.1')]);
    await useSettingsStore.getState().testApiKey();
    await useSettingsStore.getState().save();

    const written = vi.mocked(settingsStorage.save).mock.calls.at(-1)?.[0] as unknown as Record<string, unknown>;
    expect(written).toBeDefined();
    expect(written).not.toHaveProperty('modelCatalog');
    expect(written).not.toHaveProperty('modelCatalogProvider');
    expect(written).not.toHaveProperty('keyTest');
    expect(written).not.toHaveProperty('testApiKey');
    // The real settings still make it through.
    expect(written['apiKey']).toBe('sk-test');
  });
});
