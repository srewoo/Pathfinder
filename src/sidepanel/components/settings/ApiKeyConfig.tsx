import React, { useState } from 'react';
import { Eye, EyeOff, Key } from 'lucide-react';

interface ApiKeyConfigProps {
  value: string;
  onChange: (key: string) => void;
  provider: string;
}

const placeholders: Record<string, string> = {
  openai: 'sk-proj-...',
  anthropic: 'sk-ant-...',
  google: 'AIza...',
};

const docsLinks: Record<string, string> = {
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
  google: 'https://aistudio.google.com/app/apikey',
};

export function ApiKeyConfig({ value, onChange, provider }: ApiKeyConfigProps) {
  const [show, setShow] = useState(false);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-text-secondary flex items-center gap-1.5">
          <Key size={11} />
          API Key
        </label>
        <a
          href={docsLinks[provider] ?? '#'}
          target="_blank"
          rel="noreferrer"
          className="text-2xs text-primary-light hover:underline"
        >
          Get key →
        </a>
      </div>

      <div className="relative">
        <input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholders[provider] ?? 'Enter API key...'}
          className={[
            'w-full h-8 bg-surface-3 border rounded-lg px-3 pr-9 text-xs',
            'text-text-primary placeholder-text-muted',
            'border-border focus:border-primary focus:ring-1 focus:ring-primary/30',
            'outline-none transition-colors font-mono',
          ].join(' ')}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          onClick={() => setShow(!show)}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary transition-colors"
        >
          {show ? <EyeOff size={12} /> : <Eye size={12} />}
        </button>
      </div>

      {value && (
        <p className="text-2xs text-success flex items-center gap-1">
          <span className="w-1 h-1 rounded-full bg-success inline-block" />
          API key saved locally — verify it is valid on the provider dashboard
        </p>
      )}

      <p className="text-2xs text-text-muted">
        Your key is stored locally in the browser. It is never sent to any server other than the AI provider.
      </p>
    </div>
  );
}
