import { Bug, Settings, Sun, Moon, HelpCircle, Globe } from 'lucide-react';
import { useSettingsStore } from '../../stores/settings-store';
import { useActiveOrigin, shortOrigin } from './AppContext';

interface HeaderProps {
  onSettingsClick: () => void;
  /** Replay the first-run guided tour. */
  onHelpClick?: () => void;
  /**
   * What the panel is doing right now, if anything. Rendered in place of the
   * origin line while a run is in flight, because during a run that is the more
   * urgent of the two facts.
   */
  runState?: string;
}

const providerLabel = { openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google' };

/**
 * One row, and the second line spent on context rather than on a tagline.
 *
 * The subtitle used to read "AI QA Explorer" — a restatement of the product
 * name that cost a line of a 360px-wide panel on every screen. That line now
 * carries the thing every action here depends on and nothing else displayed:
 * which page the panel is pointed at, and whether a run is in progress.
 */
export function Header({ onSettingsClick, onHelpClick, runState }: HeaderProps) {
  const { provider, apiKey, theme, setTheme } = useSettingsStore();
  const { origin, known } = useActiveOrigin();
  const hasKey = Boolean(apiKey);
  const isLight = theme === 'light';

  const toggleTheme = () => setTheme(isLight ? 'dark' : 'light');

  return (
    <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border bg-surface-1 flex-shrink-0">
      <div className="flex items-center gap-2 min-w-0">
        <div className="w-5 h-5 rounded-md bg-gradient-to-br from-primary to-indigo-600 flex items-center justify-center shadow-sm flex-shrink-0">
          <Bug size={11} className="text-white" />
        </div>
        <div className="min-w-0">
          <h1 className="text-xs font-bold text-text-primary leading-none tracking-tight">
            Pathfinder
          </h1>
          <p className="flex items-center gap-1 text-2xs leading-tight mt-0.5 min-w-0">
            {runState ? (
              <span className="text-primary-text truncate">{runState}</span>
            ) : (
              <>
                <Globe size={9} className="flex-shrink-0 text-text-muted" />
                <span
                  className={`truncate ${known ? 'text-text-muted' : 'text-warning-text'}`}
                  title={known ? origin : 'No page is open in this window'}
                >
                  {/* Explicitly unknown rather than a plausible-looking guess:
                      an invented origin is worse than a missing one, because a
                      run against the wrong page looks exactly like a run
                      against the right one until the results are wrong. */}
                  {known ? shortOrigin(origin) : 'no page detected'}
                </span>
              </>
            )}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-1 flex-shrink-0">
        <span
          className="flex items-center gap-1 mr-0.5"
          title={hasKey ? `${providerLabel[provider]} key configured` : 'No API key configured'}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${hasKey ? 'bg-success' : 'bg-warning'}`} />
          <span className="text-2xs text-text-muted hidden min-[340px]:inline">
            {hasKey ? providerLabel[provider] : 'No key'}
          </span>
        </span>

        <button
          onClick={toggleTheme}
          className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
          title={isLight ? 'Switch to dark mode' : 'Switch to light mode'}
          aria-label={isLight ? 'Switch to dark mode' : 'Switch to light mode'}
        >
          {isLight ? <Moon size={13} /> : <Sun size={13} />}
        </button>

        {onHelpClick && (
          <button
            onClick={onHelpClick}
            className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
            title="Replay getting-started tour"
            aria-label="Replay getting-started tour"
          >
            <HelpCircle size={13} />
          </button>
        )}

        <button
          onClick={onSettingsClick}
          className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
          title="Settings"
          aria-label="Settings"
        >
          <Settings size={13} />
        </button>
      </div>
    </div>
  );
}
