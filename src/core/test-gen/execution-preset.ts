import type { ExecutionPreset, TestCase } from '../../storage/schemas';
import { executionPresetStorage } from '../../storage/chrome-storage';

export interface ExecutionPresetSnapshot {
  executionPresetId?: string;
  executionPresetName?: string;
  personaLabel?: string;
  requiresAuthenticatedSession?: boolean;
  setupSteps?: string[];
  setupNotes?: string;
  startUrl?: string;
}

export async function resolveExecutionPresetSnapshot(
  executionPresetId?: string
): Promise<ExecutionPresetSnapshot> {
  if (!executionPresetId) return {};

  const preset = await executionPresetStorage.getById(executionPresetId);
  if (!preset) return {};

  return snapshotExecutionPreset(preset);
}

export function snapshotExecutionPreset(preset: ExecutionPreset): ExecutionPresetSnapshot {
  return {
    executionPresetId: preset.id,
    executionPresetName: preset.name,
    personaLabel: preset.personaLabel,
    requiresAuthenticatedSession: preset.requiresAuthenticatedSession,
    setupSteps: preset.setupSteps?.length ? preset.setupSteps : undefined,
    setupNotes: preset.setupNotes || preset.description || undefined,
    startUrl: preset.startUrl || undefined,
  };
}

export async function applyExecutionPresetToDraft(
  draft: Omit<TestCase, 'status' | 'createdAt'>,
  executionPresetId?: string
): Promise<Omit<TestCase, 'status' | 'createdAt'>> {
  const preset = await resolveExecutionPresetSnapshot(executionPresetId);
  return {
    ...draft,
    executionPresetId: preset.executionPresetId,
    executionPresetName: preset.executionPresetName,
    personaLabel: preset.personaLabel,
    requiresAuthenticatedSession: preset.requiresAuthenticatedSession,
    setupSteps: preset.setupSteps ? [...preset.setupSteps] : undefined,
    setupNotes: preset.setupNotes,
    startUrl: draft.startUrl || preset.startUrl,
  };
}

export function formatExecutionPresetContext(preset?: Pick<
  ExecutionPreset,
  'name' | 'personaLabel' | 'requiresAuthenticatedSession' | 'setupSteps' | 'setupNotes'
> | null): string {
  if (!preset) return '';

  const lines = [`Execution preset: ${preset.name}`];
  if (preset.personaLabel) {
    lines.push(`Persona: ${preset.personaLabel}`);
  }
  if (preset.requiresAuthenticatedSession) {
    lines.push('Requires an authenticated in-app session before the main test starts.');
  }
  if (preset.setupNotes) {
    lines.push(`Preset notes: ${preset.setupNotes}`);
  }
  if (preset.setupSteps?.length) {
    lines.push(`Setup steps:\n${preset.setupSteps.map((step, index) => `${index + 1}. ${step}`).join('\n')}`);
  }

  return lines.join('\n');
}
