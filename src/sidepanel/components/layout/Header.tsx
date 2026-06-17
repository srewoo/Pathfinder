import React from 'react';
import { Bug, Settings, Sun, Moon, HelpCircle } from 'lucide-react';
import { useSettingsStore } from '../../stores/settings-store';

interface HeaderProps {
  onSettingsClick: () => void;
  /** Replay the first-run guided tour. */
  onHelpClick?: () => void;
}

const providerLabel = { openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google' };

export function Header({ onSettingsClick, onHelpClick }: HeaderProps) {
  const { provider, apiKey, theme, setTheme } = useSettingsStore();
  const hasKey = Boolean(apiKey);
  const isLight = theme === 'light';

  const toggleTheme = () => setTheme(isLight ? 'dark' : 'light');

  return (
    <div className="flex items-center justify-between px-3 py-2.5 border-b border-border bg-surface-1 flex-shrink-0">
      <div className="flex items-center gap-2">
        <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-primary to-indigo-600 flex items-center justify-center shadow-sm flex-shrink-0">
          <Bug size={13} className="text-white" />
        </div>
        <div>
          <h1 className="text-sm font-bold text-text-primary leading-none tracking-tight">Pathfinder</h1>
          <p className="text-2xs text-text-muted leading-tight mt-0.5">AI QA Explorer</p>
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <div className="flex items-center gap-1.5 mr-1">
          <span
            className={`w-1.5 h-1.5 rounded-full ${hasKey ? 'bg-success' : 'bg-warning'}`}
          />
          <span className="text-2xs text-text-muted">
            {hasKey ? providerLabel[provider] : 'No API key'}
          </span>
        </div>

        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
          title={isLight ? 'Switch to dark mode' : 'Switch to light mode'}
          aria-label={isLight ? 'Switch to dark mode' : 'Switch to light mode'}
        >
          {isLight ? <Moon size={13} /> : <Sun size={13} />}
        </button>

        {onHelpClick && (
          <button
            onClick={onHelpClick}
            className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
            title="Replay getting-started tour"
            aria-label="Replay getting-started tour"
          >
            <HelpCircle size={13} />
          </button>
        )}

        <button
          onClick={onSettingsClick}
          className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
          title="Settings"
        >
          <Settings size={13} />
        </button>
      </div>
    </div>
  );
}
