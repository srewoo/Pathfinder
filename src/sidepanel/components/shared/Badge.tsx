import React from 'react';

type BadgeVariant = 'primary' | 'success' | 'error' | 'warning' | 'info' | 'neutral' | 'positive' | 'negative' | 'edge';

interface BadgeProps {
  variant?: BadgeVariant;
  children: React.ReactNode;
  className?: string;
  dot?: boolean;
}

const variantClasses: Record<BadgeVariant, string> = {
  primary: 'bg-primary/15 text-primary-light border-primary/20',
  success: 'bg-success/15 text-success border-success/25',
  error: 'bg-error/15 text-error border-error/25',
  warning: 'bg-warning/15 text-warning border-warning/25',
  info: 'bg-info/15 text-info border-info/25',
  neutral: 'bg-surface-3 text-text-secondary border-border',
  positive: 'bg-success/15 text-success border-success/25',
  negative: 'bg-error/15 text-error border-error/25',
  edge: 'bg-warning/15 text-warning border-warning/25',
};

const dotColors: Record<BadgeVariant, string> = {
  primary: 'bg-primary-light',
  success: 'bg-success',
  error: 'bg-error',
  warning: 'bg-warning',
  info: 'bg-info',
  neutral: 'bg-text-muted',
  positive: 'bg-success',
  negative: 'bg-error',
  edge: 'bg-warning',
};

export function Badge({ variant = 'neutral', children, className = '', dot = false }: BadgeProps) {
  return (
    <span
      className={[
        'inline-flex items-center gap-1 px-1.5 py-0.5 text-2xs font-medium border rounded',
        variantClasses[variant],
        className,
      ].join(' ')}
    >
      {dot && (
        <span className={`w-1 h-1 rounded-full flex-shrink-0 ${dotColors[variant]}`} />
      )}
      {children}
    </span>
  );
}
