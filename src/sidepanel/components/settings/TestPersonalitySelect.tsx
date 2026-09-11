import { Drama } from 'lucide-react';
import type { TestPersonalityId } from '../../../storage/schemas';
import { listPersonalities } from '../../../core/test-gen/test-personality';

/** Free-text prompt shorter than this is too vague to steer generation. */
export const MIN_CUSTOM_PROMPT = 12;
/** Matches the 200-char slice `createCustomPersonality` applies. */
export const MAX_CUSTOM_PROMPT = 200;

interface TestPersonalitySelectProps {
  value: TestPersonalityId;
  customPrompt: string;
  onChange: (id: TestPersonalityId) => void;
  onCustomPromptChange: (prompt: string) => void;
}

/**
 * Picker for the generation personality.
 *
 * The engine has supported all seven since personalities landed; until now the
 * value could only be set by editing storage, so every install generated with
 * `balanced` whether or not that suited the app.
 *
 * `custom` is appended here rather than read from `listPersonalities()`: it has
 * no built-in definition because its behaviour comes from the user's own text.
 */
export function TestPersonalitySelect({
  value,
  customPrompt,
  onChange,
  onCustomPromptChange,
}: TestPersonalitySelectProps) {
  const builtIns = listPersonalities();
  const active = builtIns.find((p) => p.id === value);
  const isCustom = value === 'custom';
  // Only a prompt short enough to be meaningless is worth flagging — an empty
  // field is someone who has not typed yet, not an error.
  const tooShort =
    isCustom && customPrompt.trim().length > 0 && customPrompt.trim().length < MIN_CUSTOM_PROMPT;

  return (
    <div className="space-y-2">
      <label className="block text-xs font-medium text-text-secondary">
        <div className="flex items-center gap-1.5">
          <Drama size={11} className="text-text-muted" />
          Test Personality
        </div>
      </label>

      <select
        value={value}
        onChange={(e) => onChange(e.target.value as TestPersonalityId)}
        className="w-full h-8 bg-surface-3 border border-border rounded-lg px-3 text-xs text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors"
      >
        {builtIns.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
        <option value="custom">Custom…</option>
      </select>

      {!isCustom && active && <p className="text-2xs text-text-muted">{active.description}</p>}

      {isCustom && (
        <div className="space-y-1.5">
          <textarea
            value={customPrompt}
            onChange={(e) => onCustomPromptChange(e.target.value.slice(0, MAX_CUSTOM_PROMPT))}
            rows={3}
            maxLength={MAX_CUSTOM_PROMPT}
            placeholder="e.g. Focus on multi-tenant data isolation — every test should verify one tenant cannot read another's records."
            className="w-full bg-surface-3 border border-border rounded-lg px-3 py-2 text-xs text-text-primary placeholder-text-muted outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors resize-y"
          />
          <div className="flex items-center justify-between gap-2">
            <p className="text-2xs text-text-muted">
              Injected into the generation prompt for every test.
            </p>
            <span className="text-2xs text-text-muted tabular-nums flex-shrink-0">
              {customPrompt.length}/{MAX_CUSTOM_PROMPT}
            </span>
          </div>
          {customPrompt.trim().length === 0 && (
            // Without text, custom falls back to balanced — say so rather than
            // letting the user believe a personality is being applied.
            <p className="text-2xs text-warning-text">
              Empty — generation falls back to Balanced until you describe what to focus on.
            </p>
          )}
          {tooShort && (
            <p className="text-2xs text-warning-text">
              Too short to steer generation — describe what to focus on in a sentence.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
