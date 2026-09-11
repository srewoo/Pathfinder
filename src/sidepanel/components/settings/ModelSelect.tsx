import { RefreshCw, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import type { ModelOption } from '../../../core/ai/model-catalog';
import type { KeyTestStatus } from '../../stores/settings-store';

interface ModelSelectProps {
  label: string;
  value: string;
  onChange: (model: string) => void;
  /** Models the tested key can call. Empty until the key has been verified. */
  options: readonly ModelOption[];
  placeholder: string;
  /** Shown under the field when the catalogue is empty. */
  hint?: string;
}

/**
 * Model field backed by the provider's own catalogue.
 *
 * Falls back to a free-text input until the key has been tested: a user with a
 * proxy, a preview model, or no wish to test a key must still be able to type
 * an id. Once a catalogue exists, the select is the safer control because every
 * option is known to be callable with the saved key.
 */
export function ModelSelect({ label, value, onChange, options, placeholder, hint }: ModelSelectProps) {
  const fieldClass =
    'w-full h-8 bg-surface-3 border border-border rounded-lg px-3 text-xs text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors font-mono';

  if (options.length === 0) {
    return (
      <div className="space-y-2">
        <label className="block text-xs font-medium text-text-secondary">{label}</label>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={fieldClass}
          placeholder={placeholder}
        />
        {hint && <p className="text-2xs text-text-muted">{hint}</p>}
      </div>
    );
  }

  // A saved id absent from the catalogue stays selectable and is labelled as
  // such — silently switching the user's model would be worse than saying so.
  const unknown = value.length > 0 && !options.some((m) => m.id === value);

  return (
    <div className="space-y-2">
      <label className="block text-xs font-medium text-text-secondary">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={fieldClass}
      >
        {unknown && <option value={value}>{value} — not available to this key</option>}
        {options.map((model) => (
          <option key={model.id} value={model.id}>
            {model.label === model.id ? model.id : `${model.label} (${model.id})`}
          </option>
        ))}
      </select>
      {unknown && (
        <p className="text-2xs text-warning-text">
          This model is not in the key's catalogue and will fail when a test runs.
        </p>
      )}
    </div>
  );
}

interface TestKeyButtonProps {
  status: KeyTestStatus;
  onTest: () => void;
  disabled: boolean;
}

/** Verify the key and load its model catalogue in one action. */
export function TestKeyButton({ status, onTest, disabled }: TestKeyButtonProps) {
  const testing = status.state === 'testing';

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={onTest}
        disabled={disabled || testing}
        className={[
          'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg border text-2xs font-medium transition-colors',
          disabled || testing
            ? 'border-border text-text-muted cursor-not-allowed'
            : 'border-border text-text-secondary hover:bg-surface-3 hover:text-text-primary',
        ].join(' ')}
      >
        {testing ? (
          <Loader2 size={11} className="animate-spin" />
        ) : (
          <RefreshCw size={11} />
        )}
        {testing ? 'Testing key…' : 'Test key & load models'}
      </button>

      {status.state === 'ok' && status.message && (
        <p className="text-2xs text-success-text flex items-start gap-1">
          <CheckCircle size={11} className="flex-shrink-0 mt-px" />
          {status.message}
        </p>
      )}
      {status.state === 'error' && status.message && (
        <p className="text-2xs text-error-text flex items-start gap-1">
          <XCircle size={11} className="flex-shrink-0 mt-px" />
          {/* Verbatim provider text: a paraphrase loses the detail that says
              which field is wrong. */}
          {status.message}
        </p>
      )}
    </div>
  );
}
