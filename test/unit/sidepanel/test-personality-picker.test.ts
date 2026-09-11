import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  listPersonalities,
  createCustomPersonality,
  getPersonality,
} from '../../../src/core/test-gen/test-personality';
import {
  MIN_CUSTOM_PROMPT,
  MAX_CUSTOM_PROMPT,
} from '../../../src/sidepanel/components/settings/TestPersonalitySelect';
import type { TestPersonalityId } from '../../../src/storage/schemas';

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
const { settingsStorage } = await import('../../../src/storage/chrome-storage');

/**
 * Every id the type allows. Adding one to the union without adding it to
 * PERSONALITIES would leave it unreachable from the picker — this list is the
 * thing that fails when that happens.
 */
const ALL_IDS: TestPersonalityId[] = [
  'balanced',
  'happy_path',
  'aggressive_edge',
  'security_focused',
  'accessibility_first',
  'performance_minded',
  'custom',
];

describe('picker option coverage', () => {
  // The picker renders listPersonalities() plus a hardcoded 'custom'. If a new
  // personality is added to the engine and not to PERSONALITIES, it silently
  // becomes unselectable — which is exactly how these six went unusable before.
  it('given_the_id_union_then_every_id_is_offered_by_the_picker', () => {
    const offered = new Set<TestPersonalityId>([
      ...listPersonalities().map((p) => p.id),
      'custom',
    ]);
    expect([...offered].sort()).toEqual([...ALL_IDS].sort());
  });

  it('given_the_built_in_list_then_it_excludes_custom_which_the_picker_appends', () => {
    expect(listPersonalities().map((p) => p.id)).not.toContain('custom');
  });

  it('given_each_built_in_then_it_has_a_name_and_a_description_to_render', () => {
    for (const p of listPersonalities()) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
    }
  });
});

describe('custom prompt bounds', () => {
  // The textarea truncates at MAX_CUSTOM_PROMPT; storing more than the engine
  // keeps would show the user text that never reaches the model.
  it('given_the_max_length_then_it_matches_what_createCustomPersonality_retains', () => {
    const long = 'x'.repeat(MAX_CUSTOM_PROMPT + 50);
    expect(createCustomPersonality(long).description).toHaveLength(MAX_CUSTOM_PROMPT);
  });

  it('given_the_min_length_then_it_is_below_the_max', () => {
    expect(MIN_CUSTOM_PROMPT).toBeGreaterThan(0);
    expect(MIN_CUSTOM_PROMPT).toBeLessThan(MAX_CUSTOM_PROMPT);
  });

  // What the picker's empty-state warning promises.
  it('given_custom_with_no_prompt_then_generation_falls_back_to_balanced', () => {
    expect(getPersonality('custom').id).toBe('balanced');
  });
});

describe('settings store persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({
      testPersonality: 'balanced',
      customPersonalityPrompt: undefined,
    } as never);
  });

  it.each(ALL_IDS)('given_%s_selected_then_it_is_stored_and_saved', async (id) => {
    await useSettingsStore.getState().setTestPersonality(id);
    expect(useSettingsStore.getState().testPersonality).toBe(id);
    const written = vi.mocked(settingsStorage.save).mock.calls.at(-1)?.[0];
    expect(written?.testPersonality).toBe(id);
  });

  it('given_a_custom_prompt_then_it_is_stored_and_saved', async () => {
    await useSettingsStore.getState().setCustomPersonalityPrompt('Focus on tenant isolation.');
    expect(useSettingsStore.getState().customPersonalityPrompt).toBe('Focus on tenant isolation.');
    const written = vi.mocked(settingsStorage.save).mock.calls.at(-1)?.[0];
    expect(written?.customPersonalityPrompt).toBe('Focus on tenant isolation.');
  });

  // Switching away from custom must not erase the text — a user toggling to
  // compare against Balanced would lose what they wrote.
  it('given_a_switch_away_from_custom_then_the_prompt_is_retained', async () => {
    await useSettingsStore.getState().setCustomPersonalityPrompt('Focus on tenant isolation.');
    await useSettingsStore.getState().setTestPersonality('balanced');
    expect(useSettingsStore.getState().customPersonalityPrompt).toBe('Focus on tenant isolation.');
  });
});
