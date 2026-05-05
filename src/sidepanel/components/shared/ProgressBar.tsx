import React from 'react';

interface ProgressBarProps {
  value: number;
  max?: number;
  label?: string;
  sublabel?: string;
  variant?: 'primary' | 'success' | 'warning' | 'error';
  animated?: boolean;
}

const barColors = {
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-error',
};

export function ProgressBar({
  value,
  max = 100,
  label,
  sublabel,
  variant = 'primary',
  animated = true,
}: ProgressBarProps) {
  const percentage = Math.min(100, Math.max(0, Math.round((value / max) * 100)));

  return (
    <div className="space-y-1.5">
      {(label || sublabel) && (
        <div className="flex items-center justify-between">
          {label && <span className="text-xs text-text-secondary truncate">{label}</span>}
          {sublabel && <span className="text-xs text-text-muted ml-2 flex-shrink-0">{sublabel}</span>}
        </div>
      )}
      <div className="h-1.5 bg-surface-3 rounded-full overflow-hidden">
        <div
          className={[
            'h-full rounded-full transition-all duration-300',
            barColors[variant],
            animated && percentage > 0 && percentage < 100 ? 'animate-pulse-slow' : '',
          ].join(' ')}
          style={{ width: `${percentage}%` }}
        />
      </div>
      <div className="text-right">
        <span className="text-2xs text-text-muted">{percentage}%</span>
      </div>
    </div>
  );
}

export function IndeterminateBar({ label }: { label?: string }) {
  return (
    <div className="space-y-1.5">
      {label && <span className="text-xs text-text-secondary">{label}</span>}
      <div className="h-1.5 bg-surface-3 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full bg-primary animate-[loading_1.5s_ease-in-out_infinite]"
          style={{ width: '40%' }}
        />
      </div>
    </div>
  );
}
