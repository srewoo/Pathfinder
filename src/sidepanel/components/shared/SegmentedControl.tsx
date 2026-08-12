import React, { useRef } from 'react';

/**
 * One segmented control, replacing nine hand-rolled copies.
 *
 * The pattern appeared in `TabNav`, `AnalysisPanel`, `ResultsPanel`,
 * `ExplorerControls` (×2), `SettingsPanel` (×3) and `OneLineTestRunner` (×3) — each
 * with its own padding, radius and active treatment. Four different "active" styles
 * were in use — a solid fill with a shadow, a solid fill with a border, a 10% tint
 * with violet text, and an underline with a 5% wash — so the same interaction looked
 * like a different component depending on which tab you were on.
 *
 * It also fixes an accessibility gap none of the copies had: the two that are real
 * tab strips had no `role`, no `aria-selected` and no keyboard navigation, so the
 * panel's primary navigation was mouse-only. Arrow keys, Home and End work here.
 *
 * `variant="underline"` keeps the top-level nav's visual identity — a full-bleed row
 * of pills would read as a toolbar rather than as navigation.
 */
export interface SegmentOption<T extends string> {
  id: T;
  label: string;
  icon?: React.ElementType;
  /** Tooltip; falls back to the label. */
  title?: string;
  disabled?: boolean;
}

interface SegmentedControlProps<T extends string> {
  options: ReadonlyArray<SegmentOption<T>>;
  value: T;
  onChange: (value: T) => void;
  /** `pill` for in-panel switches, `underline` for the top-level tab bar. */
  variant?: 'pill' | 'underline';
  size?: 'sm' | 'md';
  /** Stack icon above label. Default for `underline`. */
  stacked?: boolean;
  /** Accessible name for the group. */
  label?: string;
  className?: string;
}

const sizeClasses = {
  sm: 'text-2xs py-1.5 px-2 gap-1',
  md: 'text-xs py-2 px-2.5 gap-1.5',
} as const;

const iconSize = { sm: 12, md: 14 } as const;

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  variant = 'pill',
  size = 'sm',
  stacked,
  label,
  className = '',
}: SegmentedControlProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const isStacked = stacked ?? variant === 'underline';

  /** Roving focus: arrows move between segments, wrapping at the ends. */
  const onKeyDown = (event: React.KeyboardEvent, index: number): void => {
    const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
    if (enabled.length === 0) return;
    const at = enabled.indexOf(index);
    let next: number | undefined;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = enabled[(at + 1) % enabled.length];
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = enabled[(at - 1 + enabled.length) % enabled.length];
    else if (event.key === 'Home') next = enabled[0];
    else if (event.key === 'End') next = enabled[enabled.length - 1];
    if (next === undefined) return;
    event.preventDefault();
    onChange(options[next].id);
    refs.current[next]?.focus();
  };

  const container =
    variant === 'underline'
      ? 'flex border-b border-border flex-shrink-0 bg-surface-1'
      : 'flex gap-1 p-1 rounded-lg bg-surface-2 border border-border';

  return (
    <div role="tablist" aria-label={label} aria-orientation="horizontal" className={`${container} ${className}`}>
      {options.map((option, index) => {
        const Icon = option.icon;
        const isActive = option.id === value;
        const active =
          variant === 'underline'
            ? 'border-primary text-primary-text bg-primary/5'
            : 'bg-primary text-white';
        const inactive =
          variant === 'underline'
            ? 'border-transparent text-text-muted hover:text-text-secondary hover:bg-surface-2'
            : 'text-text-muted hover:text-text-secondary hover:bg-surface-3';
        return (
          <button
            key={option.id}
            ref={(el) => { refs.current[index] = el; }}
            role="tab"
            aria-selected={isActive}
            // Only the active segment is tabbable; arrows move within the group.
            tabIndex={isActive ? 0 : -1}
            disabled={option.disabled}
            onClick={() => onChange(option.id)}
            onKeyDown={(e) => onKeyDown(e, index)}
            title={option.title ?? option.label}
            className={[
              'flex-1 flex items-center justify-center font-medium transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              isStacked ? 'flex-col' : 'flex-row',
              variant === 'underline' ? 'border-b-2 -mb-px' : 'rounded-md',
              sizeClasses[size],
              isActive ? active : inactive,
            ].join(' ')}
          >
            {Icon && <Icon size={iconSize[size]} />}
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
