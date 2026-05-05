import React from 'react';
import type { AIProvider } from '../../../storage/schemas';

interface ProviderSelectProps {
  value: AIProvider;
  onChange: (provider: AIProvider) => void;
}

const providers: { id: AIProvider; name: string; description: string }[] = [
  { id: 'openai', name: 'OpenAI', description: 'GPT-5 series, text-embedding-3-small' },
  { id: 'anthropic', name: 'Anthropic', description: 'Claude Sonnet 4.6 / Opus 4.7' },
  { id: 'google', name: 'Google AI', description: 'Gemini 3 Pro, text-embedding-004' },
];

export function ProviderSelect({ value, onChange }: ProviderSelectProps) {
  return (
    <div className="space-y-2">
      <label className="block text-xs font-medium text-text-secondary">AI Provider</label>
      <div className="grid gap-2">
        {providers.map((p) => (
          <button
            key={p.id}
            onClick={() => onChange(p.id)}
            className={[
              'flex items-start gap-3 p-2.5 rounded-lg border text-left transition-all',
              value === p.id
                ? 'border-primary bg-primary/10 shadow-sm'
                : 'border-border bg-surface-2 hover:border-border-light hover:bg-surface-3',
            ].join(' ')}
          >
            <div
              className={`w-3 h-3 rounded-full border-2 mt-0.5 flex-shrink-0 transition-colors ${
                value === p.id ? 'border-primary bg-primary' : 'border-text-muted'
              }`}
            />
            <div>
              <div className="text-xs font-semibold text-text-primary">{p.name}</div>
              <div className="text-2xs text-text-muted mt-0.5">{p.description}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
